import Scrollbar from '@renderer/components/Scrollbar'
import type { FC, KeyboardEvent } from 'react'
import React, { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import styled from 'styled-components'

export interface MessageOutlineEntry {
  id: string
  text: string
}

interface MessageOutlineProps {
  entries: MessageOutlineEntry[]
  onNavigate: (id: string) => void
  activeId?: string | null
  /**
   * Rows that are followed by a fork marker: `forkAfter.has(id)` draws one
   * non-interactive fork row directly after that message row, and the value is
   * the TEXT that marker shows while the outline is expanded — either the branch
   * the viewed route travels at that fork or, when the route took no branch
   * there, the fork's children-here count. Both forms come from the same label
   * rule the message stream's divider renders (`forkMarkerLabel`), so the marker
   * never invents or drops the text on its own.
   * Keys are message ids that exist in `entries` (the caller owns that filter).
   */
  forkAfter?: ReadonlyMap<string, string>
}

/** Idle window before follow resumes after a manual wheel/pointer/key interaction. */
const FOLLOW_RESUME_IDLE_MS = 800

/**
 * Expand/collapse transition: compact rows are 12px high with a 2px gap;
 * expansion grows rows to 24px with a 4px gap, and carries the panel's measured
 * width, the text and fork-label fades and the body's padding/background/shadow
 * over the same 180ms ease-out — one timeline for the whole switch, so an
 * interrupted switch reverses every one of them from where they are. A long list
 * keeps its capped body height, so only the rows move vertically; the
 * compensation below holds one row's on-screen position while they change
 * height.
 */
const EXPAND_TRANSITION_MS = 180
/**
 * The anchored row's own height is the switch's progress signal: it reaches
 * these sizes only when every row has finished growing/shrinking, so the
 * compensation ends on the settled geometry instead of on a fixed wait. A wait
 * measured from the pointer event cannot work — the render, the style change
 * and the animation all start later than the event that triggered them.
 */
const ROW_HEIGHT_COLLAPSED_PX = 12
const ROW_HEIGHT_EXPANDED_PX = 24
/** Row-height match that counts as "the switch has settled". */
const ROW_HEIGHT_SETTLE_TOLERANCE_PX = 0.05
/**
 * Safety net for a switch whose row height never reaches the target (a themed
 * or restyled rail): the compensation and its reveal still end here.
 */
const GEOMETRY_SETTLE_FALLBACK_MS = EXPAND_TRANSITION_MS + 500

/**
 * Collapse grace margin: expansion is immediate, but the collapsed rail is
 * only ~24px wide, so shrinking the moment the pointer left made it trivial
 * to drop the panel while travelling. Leaving waits this margin first.
 */
const COLLAPSE_GRACE_MS = 160

/**
 * The body's scrollbar is withheld for the length of a width transition and
 * revealed once the switch has settled. The bar is painted on the body's right
 * edge, and that edge is exactly what the switch animates: left painted, it is
 * carried across the opening panel (~151px over ~165ms on a 320px column)
 * instead of appearing where it belongs. The window is the switch's own
 * timeline plus one frame of slack — the timer is armed in the commit that
 * changes the width target, and the browser may start interpolating on the
 * following frame — so the two cannot drift apart. Only the paint is withheld:
 * the body keeps `overflow-y: auto` and its reserved gutter, so measurement,
 * scroll range and `scrollTop` are untouched by it.
 */
const SCROLLBAR_REVEAL_SETTLE_SLACK_MS = 16
const SCROLLBAR_REVEAL_DELAY_MS = EXPAND_TRANSITION_MS + SCROLLBAR_REVEAL_SETTLE_SLACK_MS

/**
 * Compact rail width, as a content width: the collapsed panel is exactly the
 * dot column the collapsed rows sit in — the 14px level-1 dot plus its 4px
 * right margin. The body's own 10px left padding and the reserved scrollbar
 * gutter sit around it, so the rail keeps the 34px strip its trigger area has
 * always been. Content, because that is the one box the width below animates
 * without measuring the body's padding or the platform's gutter.
 */
const RAIL_CONTENT_WIDTH_PX = 18
/**
 * Expanded panel cap: the reading column minus the inset the body has always
 * reserved, and never more than this. It is a cap on the *column*, not a width
 * for every screen — the expanded panel itself is measured from its content.
 */
const OUTLINE_MAX_WIDTH_PX = 320
const OUTLINE_MAX_WIDTH_INSET_PX = 24
/**
 * Expanded fork row: two rules that reserve this basis each, either side of the
 * label at this gap. The pair is what makes the rules part of the row's
 * intrinsic width (see `MessageOutlineForkSegment`), so the measured panel
 * width includes them; `measurePanelWidth` reads the same two constants the CSS
 * uses instead of a second copy of the arithmetic.
 */
const FORK_SEGMENT_BASIS_PX = 8
const FORK_ROW_GAP_PX = 8

/**
 * Sub-pixel tolerance for "this row is where it was": layout reports fractional
 * geometry, and chasing that would write the scroll offset every frame for
 * nothing.
 */
const POSITION_TOLERANCE_PX = 0.5

/**
 * "The reader is at the end of the list": the scroll offset is within this
 * distance of the content end. Fractional layout means an end reached by a drag
 * or a reveal reports a fraction of a pixel short, while anything further in —
 * the shortest row is 12px, so a whole row or more — is a browse position
 * inside the last page, not the end of it.
 */
const BOTTOM_DISTANCE_TOLERANCE_PX = 1

/**
 * `prefers-reduced-motion`: every transition of the switch is disabled, so the
 * switch is settled by the very next layout. The compensation below uses this
 * to correct once and go straight back to the follow instead of holding the
 * scroll for a transition that will never run.
 */
const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false

/**
 * The body's own horizontal padding (each side, while expanded). The panel's cap
 * has to leave room for it plus the reserved scrollbar gutter, because the
 * body's `max-width` clamps its *border* box: a panel sized to the whole cap
 * would push its own right edge past the clamp and be clipped there instead of
 * ellipsizing.
 */
const BODY_INLINE_PADDING_PX = 10

interface GeometryAnchor {
  /**
   * `row` holds one row's top at `offset` below the body's top; `end` holds the
   * list end's distance to the body's bottom at `offset`, for a reader standing
   * at the end whose visible rows all grow toward that edge.
   */
  mode: 'row' | 'end'
  /**
   * Row whose on-screen position is held (`row`), or whose height is the
   * switch's settle signal (`end`).
   */
  row: HTMLElement
  /** Row top, or distance to the content end, in px, when the switch began. */
  offset: number
}

/** The single transient geometry compensation in flight, if any. */
interface GeometryCompensation {
  raf: number
  anchor: GeometryAnchor
}

/** Stable-ID row lookup: IDs never pass through the selector parser. */
const findRow = (container: HTMLElement, id: string) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).find((el) => el.dataset.messageId === id) ??
  null

/**
 * A row counts as visible when the body shows all of it. A row cut by the
 * body's edge is only half readable, so follow still repairs that one.
 */
const isFullyVisible = (row: HTMLElement, containerRect: DOMRect) => {
  const rowRect = row.getBoundingClientRect()
  return (
    rowRect.height > 0 &&
    rowRect.top >= containerRect.top - POSITION_TOLERANCE_PX &&
    rowRect.bottom <= containerRect.bottom + POSITION_TOLERANCE_PX
  )
}

/**
 * The reference a geometry switch holds still. At the end of the list that is
 * the list end itself: the reader's view is the last row and the gap under it,
 * every row they can see grows toward that edge, and no single row top can
 * represent the growth below it. Elsewhere the active row is the one the reader
 * is looking at, so it wins whenever it is on screen. A hidden active row is
 * not dragged anywhere by a geometry change while the reader is browsing — the
 * row already on screen wins then, so the browse position survives the switch.
 * A hidden active row with follow unpaused is follow's own intent: it is
 * centered first, and that centered position is what the switch holds.
 */
const resolveGeometryAnchor = (
  container: HTMLElement,
  activeId: string | null | undefined,
  paused: boolean
): GeometryAnchor | null => {
  const containerRect = container.getBoundingClientRect()
  const containerHeight = containerRect.height || containerRect.bottom - containerRect.top
  if (containerHeight <= 0) return null
  const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
  // Genuinely at the end of the list: hold that end instead of a row top, so
  // the rows grow into the space the body already reserved and the last row
  // stays whole rather than the switch chasing a row the growth pushes past the
  // edge. The end row is only the settle signal here.
  const bottomDistance = container.scrollHeight - container.clientHeight - container.scrollTop
  const endRow = rows[rows.length - 1]
  if (endRow && bottomDistance <= BOTTOM_DISTANCE_TOLERANCE_PX) {
    return { mode: 'end', row: endRow, offset: Math.max(bottomDistance, 0) }
  }
  const activeRow = activeId ? findRow(container, activeId) : null
  if (activeRow && !paused && !isFullyVisible(activeRow, containerRect)) {
    const activeRect = activeRow.getBoundingClientRect()
    const rowHeight = activeRect.height || activeRect.bottom - activeRect.top
    return { mode: 'row', row: activeRow, offset: Math.max((containerHeight - rowHeight) / 2, 0) }
  }
  if (activeRow && isFullyVisible(activeRow, containerRect)) {
    return { mode: 'row', row: activeRow, offset: activeRow.getBoundingClientRect().top - containerRect.top }
  }
  // Browsing, or an anchor that is not in the list: hold the row in view.
  const visibleRow =
    rows.find((row) => {
      const rowRect = row.getBoundingClientRect()
      return rowRect.height > 0 && rowRect.bottom > containerRect.top && rowRect.top < containerRect.bottom
    }) ?? null
  if (!visibleRow) return null
  return { mode: 'row', row: visibleRow, offset: visibleRow.getBoundingClientRect().top - containerRect.top }
}

/**
 * One correction: put the reference back where it was. Only the body's
 * scrollTop moves, so this neither resizes content nor re-triggers the
 * ResizeObserver, and the browser clamps at the content ends — a row near the
 * start or the end of the list rides that edge instead of an arbitrary offset.
 * A row reference holds that row's top; an end reference holds the distance
 * between the content end and the body's bottom, the only reference that
 * survives the rows below the reader growing toward that edge.
 */
const applyGeometryAnchor = (container: HTMLElement, anchor: GeometryAnchor) => {
  // A row that left the list has no geometry to hold. An end reference measures
  // the content end instead, so it also survives a replaced row list.
  if (anchor.mode === 'row' && !anchor.row.isConnected) return
  // A body without overflow has nothing to scroll.
  if (container.scrollHeight <= container.clientHeight + 1) return
  const drift =
    anchor.mode === 'end'
      ? container.scrollHeight - container.clientHeight - anchor.offset - container.scrollTop
      : anchor.row.getBoundingClientRect().top - (container.getBoundingClientRect().top + anchor.offset)
  if (Math.abs(drift) < POSITION_TOLERANCE_PX) return
  container.scrollTop += drift
}

/**
 * MessageOutline presentation restored from f2b83d806c with an approved
 * compact size fix: text is a fixed 13px (was $level-derived 15px at
 * level 1) and the body is capped at max-width min(320px, calc(100% - 24px))
 * / max-height min(100%, 45vh, 420px) (was 50% / min(100%, 70vh)).
 * The body is vertically centered in the chat reading area by pure CSS flex
 * layout on the container (align-items center over the full reading height),
 * never by a per-count estimated top offset, JS measurement, or transform
 * (a ResizeObserver only re-runs the anchor follow so edge-band geometry
 * is measured at the post-transition actual size).
 * Compact rows are 12px high with a 2px gap; entering the body expands
 * (180ms ease-out) to the original 24px row / 4px gap / dot-text 8px geometry
 * and leaving restores the compact rail after a short grace, with DOM,
 * positioning, single-line ellipsis, trigger area and navigation behavior
 * unchanged.
 *
 * The switch is ONE reversible transition, not a state swap with animations
 * bolted on. Entering is immediate and leaving waits COLLAPSE_GRACE_MS, but past
 * that point both directions interpolate the same properties from whatever the
 * screen currently shows: the panel's width (measured, see `measurePanelWidth`),
 * the rows' heights and the content's gap, the text's and the fork label's
 * opacity and clip, and the body's padding, background and shadow. Nothing is
 * held back for later, so a pointer that leaves and returns mid-collapse turns
 * the running transition around in place, and no state, width, text or chrome
 * ever lands in a single frame. The content beside the panel keeps its own
 * intrinsic width in both states, so the panel's animation moves a clip and
 * never reflows the rows; the row-height switch is what the geometry
 * compensation below follows.
 * $level props stay because dot size/padding still use them.
 * prefers-reduced-motion disables every transition, so the same switch settles in
 * the frame it is applied instead of waiting out a timeline.
 * The body's own scrollbar is the one thing the switch does not interpolate:
 * it is painted on the very edge the width animates, so it is withheld for the
 * transition's window and revealed once the panel has settled at its final
 * width (see `SCROLLBAR_REVEAL_DELAY_MS`).
 * A fork marker (`forkAfter`) is a separate NON-interactive row inserted
 * directly after the marked message row: it is never a navigation target (no
 * role, stable id, tab stop, handler or active highlight), so the marked
 * message row keeps its own hitbox and stays reachable. Its row height matches
 * the message rows exactly (12px compact / 24px expanded, same row gap), so
 * compact and expanded rows line up 1:1.
 * Compact it is two 6px dashes with a 2px gap — 14px total, exactly the dot
 * band it sits in — with its label clipped to zero width and transparent.
 * Expanded it becomes `── <text> ──` in the message flow's divider form: two 1px
 * rules sharing the space above an 8px basis, an 8px gap and the fork's label in
 * the middle, left-aligned with the dot column. That basis is what makes the
 * rules part of the row's intrinsic width, so the rail always grows enough to
 * show both of them next to the label — even when every message preview is
 * shorter than the label (short messages) — and a wider rail still splits its
 * surplus between them. The row also keeps its stretched width in both states
 * and only its gap, its rules' flex basis and the label's clip switch, so the
 * marker spreads and fades instead of re-placing itself inside a still-open
 * panel.
 * The text is the message flow's own two states (`forkMarkerLabel`): the branch
 * this route travels at the fork, or the fork's `此处有 {{count}} 条分支` count
 * when the route took none — a fork is never drawn as a bare line. No caret:
 * the flow's `▾` belongs to a clickable popover trigger, and this row is not
 * interactive. The label stays in the DOM in both states (decorative,
 * `aria-hidden`, non-interactive) because mounting it on expansion would replace
 * the fade with a pop and take its width away from the measurement.
 *
 * Active highlight (`activeId`) is theme-colored with `aria-current` and the
 * outline container follows it only when the row is NOT fully visible inside
 * the body: a row the reader can already see keeps the position it has, so only
 * the outline container's own scrollTop ever moves, and only for a row past the
 * box edge or cut by it — never `scrollIntoView`, which would move the chat.
 * An expand/collapse switch changes every row's height at once while a long list
 * keeps the body at its capped height, so both directions hold one row's
 * on-screen position frame by frame for the length of the transition (which row
 * wins, and why it need not be the active one, is decided in
 * `resolveGeometryAnchor`): the row never leaves the box, so there is no drift
 * and nothing to snap back.
 * At the end of the list the window holds the list end's distance to the box
 * bottom instead of a row top: there the rows the reader sees are the ones
 * growing toward that edge, so the last row stays whole and the grown scroll
 * range is reached instead of left short.
 * Manual wheel/pointer/key interaction pauses follow until a short idle window
 * passes; drag releases on document `pointerup`. A paused interaction defers
 * the follow instead of dropping it, and an interrupted geometry switch hands
 * its reveal to that same deferred path.
 */
const MessageOutline: FC<MessageOutlineProps> = ({ entries, onNavigate, activeId, forkAfter }) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const followPausedRef = useRef(false)
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafRef = useRef<number | null>(null)
  // Follow intent that arrived while the user was in control of the outline.
  // The interaction pause below suppresses the motion, never the intent: when
  // its idle window closes, follow lands on the anchor that is current then.
  const pendingFollowRef = useRef(false)
  // Expansion is a JS state machine (not CSS :hover) so leaving can wait for
  // COLLAPSE_GRACE_MS while entering stays immediate.
  const [expanded, setExpanded] = useState(false)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const geometryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The single transient compensation in flight (see
  // `startGeometryCompensation`): while it is set, it — not the follow — owns
  // the body's scrollTop.
  const geometryCompensationRef = useRef<GeometryCompensation | null>(null)
  // Anchor read by the deferred paths (geometry settle, pause expiry). Both run
  // after the render that armed them, where the prop closure would still hold
  // the previous anchor — a late anchor change must win.
  const latestActiveIdRef = useRef<string | null | undefined>(activeId)
  latestActiveIdRef.current = activeId

  // Measured presentation widths (see `measurePanelWidth`): the expanded
  // panel's own width and the column cap it may not exceed. Both are read from
  // layout, never modelled per screen.
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [panelWidthPx, setPanelWidthPx] = useState(RAIL_CONTENT_WIDTH_PX)
  const [panelCapPx, setPanelCapPx] = useState<number | null>(null)
  // Read by the resize observer, which runs outside the render that set it.
  const latestExpandedRef = useRef(expanded)
  latestExpandedRef.current = expanded
  // Whether the body's scrollbar may be painted (see
  // `SCROLLBAR_REVEAL_DELAY_MS`). It is derived from `expanded` in the same
  // render that starts the width transition, so both directions withhold the
  // bar on their first frame: opening paints nothing at the compact edge, and
  // closing drops it before the panel narrows. Only the reveal is deferred, so
  // only the reveal needs a timer.
  const [scrollbarSettled, setScrollbarSettled] = useState(false)
  const scrollbarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * The width the expanded panel needs, measured instead of decided.
   *
   * The panel cannot be `max-content`: a keyword cannot be interpolated with the
   * compact rail, so one frame would carry the whole 141px step — the switch
   * would not be a transition at all. It cannot be a fixed number either. So it
   * is read back from layout: the content box is laid out at its own intrinsic
   * width in *both* states (the panel clips it while compact, and never reflows
   * it for the animation), which is exactly the width the expanded panel ends
   * at, and it follows short, long and streaming-updated text with no model of
   * its own.
   *
   * Two inputs are added from their own geometry rather than the content box:
   * a fork row's label only owns layout width while expanded, so its row is the
   * label's measured text width plus the two rule bases and gaps the CSS
   * reserves (read from the same constants the CSS uses); and the cap is the
   * body's own — the reading column's cap minus the padding and the stable
   * scrollbar gutter the body reserves around the panel, so the panel never
   * pushes past the body's `max-width` clamp (which would clip it instead of
   * ellipsizing the row at that edge).
   */
  const measurePanelWidth = useCallback((expandedTarget: boolean) => {
    const container = containerRef.current
    const content = contentRef.current
    const host = container?.parentElement
    if (!container || !content || !host) return
    const hostWidth = host.getBoundingClientRect().width
    if (hostWidth <= 0) return
    const bodyCap = Math.min(OUTLINE_MAX_WIDTH_PX, hostWidth - OUTLINE_MAX_WIDTH_INSET_PX)
    const bodyChrome = 2 * BODY_INLINE_PADDING_PX + Math.max(container.offsetWidth - container.clientWidth, 0)
    const cap = Math.max(RAIL_CONTENT_WIDTH_PX, bodyCap - bodyChrome)
    setPanelCapPx((previous) => (previous === cap ? previous : cap))
    if (!expandedTarget) return
    let needed = content.getBoundingClientRect().width
    for (const label of container.querySelectorAll<HTMLElement>('[data-outline-fork-label]')) {
      const labelWidth = label.scrollWidth
      if (labelWidth > 0) needed = Math.max(needed, labelWidth + 2 * (FORK_SEGMENT_BASIS_PX + FORK_ROW_GAP_PX))
    }
    if (needed <= 0) return
    const width = Math.min(needed, cap)
    setPanelWidthPx((previous) => (Math.abs(previous - width) < 0.5 ? previous : width))
  }, [])

  // Before paint: the first frame of the switch already animates towards the
  // width this state really needs, so entering never opens towards a stale one.
  useLayoutEffect(() => {
    measurePanelWidth(expanded)
  }, [expanded, measurePanelWidth])

  // The scrollbar's paint window. Any change of the width target — opening,
  // closing, and a re-measure while open — hides the bar and re-arms the reveal,
  // so a reversal can never reveal a bar on an edge that is still moving and a
  // rapid re-entry restarts the settlement instead of inheriting the first
  // window's. Running before paint keeps the withhold in the same frame as the
  // transition, and clearing at the head of every run (plus on unmount) keeps at
  // most one reveal timer alive.
  useLayoutEffect(() => {
    if (scrollbarTimerRef.current) {
      clearTimeout(scrollbarTimerRef.current)
      scrollbarTimerRef.current = null
    }
    if (!expanded) {
      // Compact paints no scrollbar anyway (`overflow-y: hidden`), so there is
      // nothing to wait for: a pending reveal is dropped, not rescheduled.
      setScrollbarSettled(false)
      return
    }
    if (prefersReducedMotion()) {
      // No timeline runs, so the final edge is already on screen: settle now
      // rather than arm a timer nothing will turn back off.
      setScrollbarSettled(true)
      return
    }
    setScrollbarSettled(false)
    scrollbarTimerRef.current = setTimeout(() => {
      scrollbarTimerRef.current = null
      setScrollbarSettled(true)
    }, SCROLLBAR_REVEAL_DELAY_MS)
  }, [expanded, panelWidthPx])

  // The content's box changes when its text does, and the column when the
  // window or the layout column does: both are measurement inputs. Neither is
  // driven by the panel's animated width — the content is intrinsically sized
  // and the panel clips it — so observing them cannot feed back into the
  // transition.
  useEffect(() => {
    const content = contentRef.current
    const host = containerRef.current?.parentElement
    if (!content || !host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measurePanelWidth(latestExpandedRef.current))
    observer.observe(content)
    observer.observe(host)
    return () => observer.disconnect()
  }, [measurePanelWidth])

  // Container-local follow: the outline's own scrollTop moves only for an
  // active row that is not fully visible inside the body. A row the reader can
  // already see keeps the exact position it has, so reading the rail never
  // re-centers a visible highlight — and a geometry switch has nothing to snap
  // back afterwards. The browser clamps scrollTop at the content ends, so
  // first/last rows rest at the boundary instead of centering.
  // The target is always the reading anchor — never the hovered row — so
  // expansion can never scroll to a wrong item.
  const revealActiveRow = useCallback((targetId: string) => {
    if (followPausedRef.current) return
    // A geometry switch owns the scroll for its own duration: a mid-transition
    // follow would measure half-grown rows and fight the compensation.
    if (geometryCompensationRef.current) return
    const container = containerRef.current
    if (!container) return
    const row = findRow(container, targetId)
    if (!row) return
    const containerRect = container.getBoundingClientRect()
    const containerHeight = containerRect.height || containerRect.bottom - containerRect.top
    if (containerHeight <= 0) return
    // No scrollable overflow (short list): centering is meaningless.
    if (container.scrollHeight <= container.clientHeight + 1) return
    if (isFullyVisible(row, containerRect)) return
    const rowRect = row.getBoundingClientRect()
    const rowCenter = (rowRect.top + rowRect.bottom) / 2
    const containerCenter = (containerRect.top + containerRect.bottom) / 2
    container.scrollTop += rowCenter - containerCenter
  }, [])

  /** Run the follow on the next frame, replacing any still-scheduled frame. */
  const scheduleFollow = useCallback(
    (targetId: string) => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        revealActiveRow(targetId)
      })
    },
    [revealActiveRow]
  )

  /**
   * Follow intent. While the user is browsing the outline the motion is held,
   * not dropped: the idle window below resumes onto whatever anchor is current
   * at that moment, so a reveal never waits for an unrelated rerender.
   */
  const requestFollow = useCallback(
    (targetId: string | null | undefined) => {
      const id = targetId ?? latestActiveIdRef.current
      if (!id) return
      if (followPausedRef.current) {
        pendingFollowRef.current = true
        return
      }
      pendingFollowRef.current = false
      scheduleFollow(id)
    },
    [scheduleFollow]
  )

  /** Idle window closed: resume follow, landing any intent it was holding. */
  const resumeFollow = useCallback(() => {
    followPausedRef.current = false
    if (!pendingFollowRef.current) return
    pendingFollowRef.current = false
    const targetId = latestActiveIdRef.current
    if (targetId) scheduleFollow(targetId)
  }, [scheduleFollow])

  const scheduleResume = useCallback(() => {
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current)
      resumeTimerRef.current = null
    }
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null
      resumeFollow()
    }, FOLLOW_RESUME_IDLE_MS)
  }, [resumeFollow])

  /**
   * Drop the transient compensation. A switch that was interrupted still owes
   * the reader a reveal, so that intent is handed to the deferred follow path
   * (`pendingFollowRef`) instead of being dropped, exactly like a follow that
   * arrives while the reader is in control of the outline.
   */
  const stopGeometryCompensation = useCallback((deferFollow: boolean) => {
    const current = geometryCompensationRef.current
    if (current) {
      geometryCompensationRef.current = null
      if (current.raf) cancelAnimationFrame(current.raf)
      if (deferFollow) pendingFollowRef.current = true
    }
    if (geometryTimerRef.current) {
      clearTimeout(geometryTimerRef.current)
      geometryTimerRef.current = null
    }
  }, [])

  const pauseFollow = useCallback(() => {
    followPausedRef.current = true
    stopGeometryCompensation(true)
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    scheduleResume()
  }, [scheduleResume, stopGeometryCompensation])

  /**
   * Hold one row's on-screen position across an expand/collapse height switch.
   *
   * The switch re-lays out every row at once (12px + 2px gap <-> 24px + 4px
   * gap) while a long list keeps the body at its capped height, so a retained
   * scrollTop carries the row the reader is looking at out of the box, and the
   * follow could only snap it back after the transition. Instead, take that
   * row's position now — before the new geometry lands — and re-apply it on
   * every frame of the transition: the row stays where it is drawn and the
   * scroll offset absorbs the layout change. Geometry is read inside each frame
   * callback, which measures the geometry that frame is about to paint, so the
   * correction lands before the paint and no frame shows the drift.
   *
   * A reader who is at the end of the list has no row top to hold: the rows
   * above the end are the ones growing, so this window holds the end's own
   * distance to the box bottom instead (`resolveGeometryAnchor` picks that
   * reference), and the anchored row's height still carries it to the settled
   * geometry.
   *
   * It ends on the settled geometry — the anchored row reaches its expanded or
   * collapsed height — not after a fixed wait: the render and the animation
   * start after the event that caused them, so a wait measured from the event
   * would stop the compensation while rows are still growing. The last frame
   * corrects once more and hands the scroll back to the ordinary follow: for a
   * row the compensation kept visible that follow writes nothing, and for one
   * it could not hold (a list edge, a replaced row list) it reveals the row as
   * usual. A paused browse still defers its reveal; a gesture or an unmount
   * drops the compensation.
   */
  const startGeometryCompensation = useCallback(
    (expandedTarget: boolean) => {
      stopGeometryCompensation(false)
      const container = containerRef.current
      const anchor = container
        ? resolveGeometryAnchor(container, latestActiveIdRef.current, followPausedRef.current)
        : null
      const targetHeight = expandedTarget ? ROW_HEIGHT_EXPANDED_PX : ROW_HEIGHT_COLLAPSED_PX
      let done = false
      const finish = () => {
        if (done) return
        done = true
        if (geometryTimerRef.current) {
          clearTimeout(geometryTimerRef.current)
          geometryTimerRef.current = null
        }
        const current = geometryCompensationRef.current
        const liveContainer = containerRef.current
        if (current) {
          geometryCompensationRef.current = null
          if (current.raf) cancelAnimationFrame(current.raf)
          // Settled geometry: the last correction of the switch.
          if (liveContainer) applyGeometryAnchor(liveContainer, current.anchor)
        }
        requestFollow(latestActiveIdRef.current)
      }
      // Reduced motion: the switch is settled the moment it is applied, so there
      // is no window to hold and nothing to wait out. Correct once and hand the
      // scroll straight back to the follow — no frame loop, no settle timer.
      if (prefersReducedMotion()) {
        const liveContainer = containerRef.current
        if (anchor && liveContainer && liveContainer.scrollHeight > liveContainer.clientHeight + 1) {
          applyGeometryAnchor(liveContainer, anchor)
        }
        requestFollow(latestActiveIdRef.current)
        return
      }
      // Safety net only: a restyled rail may never reach the target row height.
      geometryTimerRef.current = setTimeout(() => {
        geometryTimerRef.current = null
        finish()
      }, GEOMETRY_SETTLE_FALLBACK_MS)
      // No body, or no scroll range (short list): there is nothing to compensate.
      if (!anchor || !container) return
      if (container.scrollHeight <= container.clientHeight + 1) return
      const state: GeometryCompensation = { raf: 0, anchor }
      geometryCompensationRef.current = state
      const tick = () => {
        if (geometryCompensationRef.current !== state) return
        const liveContainer = containerRef.current
        if (!liveContainer) return
        applyGeometryAnchor(liveContainer, state.anchor)
        const rowHeight = state.anchor.row.isConnected ? state.anchor.row.getBoundingClientRect().height : targetHeight
        if (Math.abs(rowHeight - targetHeight) <= ROW_HEIGHT_SETTLE_TOLERANCE_PX) {
          finish()
          return
        }
        state.raf = requestAnimationFrame(tick)
      }
      state.raf = requestAnimationFrame(tick)
    },
    [requestFollow, stopGeometryCompensation]
  )

  // Drag release anywhere releases the pause via the idle window; RAF, timers
  // and any compensation still in flight are cleaned up on unmount.
  useEffect(() => {
    const handlePointerUp = () => {
      if (followPausedRef.current) scheduleResume()
    }
    document.addEventListener('pointerup', handlePointerUp)
    return () => {
      document.removeEventListener('pointerup', handlePointerUp)
      pendingFollowRef.current = false
      stopGeometryCompensation(false)
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current)
        resumeTimerRef.current = null
      }
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current)
        collapseTimerRef.current = null
      }
      if (scrollbarTimerRef.current) {
        clearTimeout(scrollbarTimerRef.current)
        scrollbarTimerRef.current = null
      }
    }
  }, [scheduleResume, stopGeometryCompensation])

  // Reading-anchor follow: a changed anchor is always a follow intent (held
  // while the user browses, landed on resume). A row-list change is only
  // followed while the user is not browsing — `entries` gets a new identity on
  // every caller render, and streaming must never take over a paused outline.
  const previousActiveIdRef = useRef<string | null | undefined>(activeId)
  useEffect(() => {
    const anchorChanged = previousActiveIdRef.current !== activeId
    previousActiveIdRef.current = activeId
    if (!activeId) return
    if (!anchorChanged && followPausedRef.current) return
    requestFollow(activeId)
  }, [activeId, entries, requestFollow])

  // A body-box change (a short list: the box itself grows or shrinks) still
  // re-runs the follow, so the active row is measured at the size the box ends
  // at. An expand/collapse switch also fires this observer — the body's content
  // width changes even while its height stays capped — but the geometry
  // compensation owns the scroll for that window, so the follow stays out of
  // its way instead of splitting the transition across two writers.
  // Scrolling never resizes content, so this cannot self-trigger.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !activeId) return
    if (typeof ResizeObserver === 'undefined') return
    let raf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => revealActiveRow(activeId))
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [activeId, revealActiveRow])

  if (!entries.length) return null

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onNavigate(id)
    }
  }

  // Entering expands at once, replacing the CSS :hover it used to rely on. The
  // switch holds the row on screen still for its length instead of letting the
  // taller rows drift it out of the box.
  const handleBodyMouseEnter = () => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current)
      collapseTimerRef.current = null
    }
    setExpanded(true)
    startGeometryCompensation(true)
  }

  // Leaving only starts the collapse; the grace margin above is the travel
  // slack for a pointer that crosses the thin collapsed rail. The collapse
  // holds the same on-screen row instead of keeping a scroll offset that only
  // made sense at the expanded row heights, so the compact rail ends up showing
  // the row the reader was looking at rather than snapping it back afterwards.
  const handleBodyMouseLeave = () => {
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current)
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null
      setExpanded(false)
      startGeometryCompensation(false)
    }, COLLAPSE_GRACE_MS)
  }

  return (
    <MessageOutlineContainer data-testid="conversation-navigation">
      <MessageOutlineBody
        ref={containerRef}
        $expanded={expanded}
        // Painted only where the switch has finished: compact never paints one,
        // and an open panel only once its final width is on screen.
        $scrollbarVisible={expanded && scrollbarSettled}
        onMouseEnter={handleBodyMouseEnter}
        onMouseLeave={handleBodyMouseLeave}
        onWheel={pauseFollow}
        onPointerDown={pauseFollow}
        onKeyDownCapture={pauseFollow}>
        {/*
          One measured width, one animated box. The panel is the only thing the
          switch interpolates horizontally; the content beside it keeps its own
          intrinsic width in both states, so the panel clips a stable layout
          instead of reflowing every row on every frame of the transition.
        */}
        <MessageOutlinePanel
          data-testid="conversation-nav-panel"
          style={{ width: expanded ? panelWidthPx : RAIL_CONTENT_WIDTH_PX }}>
          <MessageOutlineContent ref={contentRef} style={panelCapPx == null ? undefined : { maxWidth: panelCapPx }}>
            {entries.map((entry) => {
              const isActive = activeId != null && entry.id === activeId
              const hasFork = forkAfter?.has(entry.id) ?? false
              const forkText = forkAfter?.get(entry.id) ?? ''
              return (
                <Fragment key={entry.id}>
                  <MessageOutlineItem
                    $active={isActive}
                    onClick={() => onNavigate(entry.id)}
                    onKeyDown={(event) => handleKeyDown(event, entry.id)}
                    tabIndex={0}
                    role="button"
                    aria-label={entry.text}
                    aria-current={isActive ? true : undefined}
                    data-testid={`conversation-nav-item-${entry.id}`}
                    data-message-id={entry.id}
                    title={entry.text}>
                    <MessageOutlineItemDot $level={1} />
                    <MessageOutlineItemText $level={1} $miniLevel={1}>
                      {entry.text}
                    </MessageOutlineItemText>
                  </MessageOutlineItem>
                  {/*
                    Fork marker: a separate row directly AFTER the marked message
                    row, never a message row itself — no stable id, role, tab stop
                    or handler, so it can never be a navigation target, a highlight
                    winner or a follow target. Decorative only (`aria-hidden`): the
                    message row next to it is the navigation entry.

                    Expanded it reads `── <text> ──`, the message flow's divider
                    text without its `▾` (that caret belongs to the flow's clickable
                    popover trigger, and this row is not interactive). The label is
                    mounted in BOTH states and only its own clip and opacity switch:
                    mounting it on expansion would replace the fade with a pop, and
                    the row would lose the label's width while measuring it. It is
                    always present, because the caller supplies the flow's
                    untaken-fork count form when the route took no branch here.
                  */}
                  {hasFork ? (
                    <MessageOutlineForkRow
                      aria-hidden="true"
                      data-testid="conversation-nav-fork"
                      key={`fork-${entry.id}`}>
                      <MessageOutlineForkSegment />
                      <MessageOutlineForkName data-outline-fork-label>{forkText}</MessageOutlineForkName>
                      <MessageOutlineForkSegment />
                    </MessageOutlineForkRow>
                  ) : null}
                </Fragment>
              )
            })}
          </MessageOutlineContent>
        </MessageOutlinePanel>
      </MessageOutlineBody>
    </MessageOutlineContainer>
  )
}

const MessageOutlineContainer = styled.div`
  position: absolute;
  // Left-edge inset reserves the segment group-label lane: the label pill
  // (LineContainer left:-12, TabContainer max-width 280, z1000) sits above
  // the nav layer (z999) and its own contained hit region never enters the
  // nav body, so label hover cannot expand the nav. The body starts past
  // the label's left zone; the nav's own collapsed-dot trigger still
  // expands on direct hover of its uncovered area.
  inset: 0 0 0 10px;
  z-index: 999;
  pointer-events: none;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  & ~ .message-content-container {
    padding-left: 46px !important;
  }
  & ~ .MessageFooter {
    margin-left: 46px !important;
  }
`

const MessageOutlineItemDot = styled.div<{ $level: number }>`
  width: ${({ $level }) => 16 - $level * 2}px;
  height: 4px;
  background: var(--color-border);
  border-radius: 2px;
  margin-right: 4px;
  flex-shrink: 0;
  transition: background 0.2s ease;
`

/**
 * Expanded text. It is mounted in both states and only its opacity switches:
 * `display` cannot animate, so a `display: none` collapse would replace the fade
 * with a pop, and the row would lose the text's width while the panel measures
 * itself. Compact it is fully transparent, and the panel's own clip keeps it out
 * of the 34px rail, so nothing about it is visible before its fade starts.
 */
const MessageOutlineItemText = styled.div<{ $level: number; $miniLevel: number }>`
  overflow: hidden;
  color: var(--color-text-3);
  opacity: 0;
  transition: opacity ${EXPAND_TRANSITION_MS}ms ease-out;
  padding: 2px 8px;
  padding-left: ${({ $level, $miniLevel }) => ($level - $miniLevel) * 8}px;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const MessageOutlineItem = styled.div<{ $active?: boolean }>`
   height: 12px;
   display: flex;
   align-items: center;
   gap: 8px;
   cursor: pointer;
   flex-shrink: 0;
   overflow: hidden;
   transition: height ${EXPAND_TRANSITION_MS}ms ease-out;
  &:hover {
    ${MessageOutlineItemText} {
      color: var(--color-text-2);
    }
    ${MessageOutlineItemDot} {
      background: var(--color-text-3);
    }
  }
  ${({ $active }) =>
    $active &&
    `
    ${MessageOutlineItemText} {
      color: var(--color-text-1);
    }
    ${MessageOutlineItemDot} {
      background: var(--color-primary);
    }
    &:hover ${MessageOutlineItemDot} {
      background: var(--color-primary);
    }
  `}
`

/**
 * The panel: the one width the switch animates, and the box the compact rail
 * clips. It is not `max-content` (a keyword cannot be interpolated with the
 * compact width, so the whole step would land in one frame) and not a fixed size
 * either — the component measures the width it needs and writes it here, so the
 * browser can interpolate it, and an interrupted switch turns around from
 * whatever width is on screen at that moment.
 *
 * `overflow: visible` matters: the content beside it keeps its own intrinsic
 * width in both states, so the animation moves a clip instead of reflowing every
 * row, and that width stays measurable while the panel is narrow.
 */
const MessageOutlinePanel = styled.div`
  flex: 0 0 auto;
  overflow: visible;
  transition: width ${EXPAND_TRANSITION_MS}ms ease-out;
`

/**
 * The measured content: as wide as its own rows at all times — short and long
 * previews, fork labels, streaming text, a resized column (the `max-width` the
 * component measures is the reading column's cap, so a row ellipsizes exactly
 * where the fully expanded panel ends). Its gap is the body's former row gap.
 */
const MessageOutlineContent = styled.div`
  display: flex;
  flex-direction: column;
  width: max-content;
  gap: 2px;
  transition: gap ${EXPAND_TRANSITION_MS}ms ease-out;
`

/**
 * Fork marker row: the same height as a message row in both states (12px
 * collapsed / 24px expanded), and the content owns the shared row gap, so the
 * collapsed and expanded lists line up row for row.
 *
 * Collapsed it occupies exactly the dot band — 6px + 1px gap + a zero-wide label
 * + 1px gap + 6px = the 14px dot width — so the dashes read as one short
 * interruption of the rail instead of two separated strokes. Expanded it hosts
 * the fork's label (branch name or count form) between its two rules at the
 * flow's 8px gap; the rules' 8px basis is part of that row's intrinsic width, so
 * the row never resolves to "label only".
 *
 * The row keeps its stretched width in both states on purpose: shrinking it to
 * the 14px band at the switch would re-place the label and both rules inside a
 * still-open panel — the very pop the width transition exists to remove. Only
 * heights, the gap and the label's own clip switch, and they all interpolate.
 * Not interactive: no cursor, no hover state.
 */
const MessageOutlineForkRow = styled.div`
  height: 12px;
  align-self: stretch;
  display: flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
  pointer-events: none;
  transition:
    height ${EXPAND_TRANSITION_MS}ms ease-out,
    gap ${EXPAND_TRANSITION_MS}ms ease-out;
`
/**
 * One dash. Collapsed it is a 6px stroke with the dot's 2px radius. Expanded it
 * keeps an 8px base size and then grows into whatever width the row has left,
 * so the two rules read as the dividers around the name — the same 1px
 * `var(--color-border)` line the message-flow fork divider draws.
 *
 * The base size is not zero on purpose. The content is sized by its widest row,
 * and a zero-base rule contributes nothing to that intrinsic width: when the
 * fork's label was the widest thing in the rail (short messages like "hi"), the
 * row spent its whole width on the label and both rules measured zero — the
 * divider lost its lines. A real base makes the two rules part of the row's
 * intrinsic width, so the rail grows just enough to show `line — label — line`.
 * Growth then hands any surplus to the rules, so a wide rail still draws the
 * dividers out to its two ends instead of leaving two short dashes beside a wide
 * gap, and the 8px floor keeps a visible line even when a capped panel has to
 * shrink the row. `flex` is what interpolates here (a `width: auto` target
 * cannot), so the pair spreads out of the dot band instead of jumping.
 */
const MessageOutlineForkSegment = styled.div`
  width: 6px;
  height: 1px;
  background: var(--color-border);
  border-radius: 2px;
  flex: 0 0 6px;
  transition:
    flex ${EXPAND_TRANSITION_MS}ms ease-out,
    min-width ${EXPAND_TRANSITION_MS}ms ease-out;
`
/**
 * The fork's label between the two rules: the message-flow divider's text form
 * (11.5px, secondary text color) at the flow's 8px gap. It never wraps or
 * shrinks, so the rules absorb every width change around it.
 *
 * Compact it is clipped to zero width and transparent instead of being unmounted
 * or hidden with `display`: both of those would make the label appear and
 * disappear in a single frame. Its clip and its opacity interpolate, and the
 * fade is what masks the (necessarily faster) width change — the text is already
 * gone by the time the hint of it would be readable.
 */
const MessageOutlineForkName = styled.div`
  flex: 0 0 auto;
  max-width: 0;
  overflow: hidden;
  font-size: 11.5px;
  color: var(--color-text-2);
  white-space: nowrap;
  opacity: 0;
  transition:
    max-width ${EXPAND_TRANSITION_MS}ms ease-out,
    opacity ${EXPAND_TRANSITION_MS}ms ease-out;
`
/**
 * `$expanded` and `$scrollbarVisible` are transient props (styled-components
 * never forwards them to the DOM); they are projected onto `data-expanded` and
 * `data-outline-scrollbar` so the expanded geometry and the scrollbar's paint
 * window stay static CSS rules instead of per-render dynamic interpolations.
 *
 * The body is the clip and the scroll container, not the width owner: it is
 * intrinsically sized around the panel, so its 34px compact strip and its
 * expanded width both come from the one width the panel animates, plus this
 * box's own padding. Its background, shadow and padding are part of the same
 * transition as the rows, so the chrome eases in with them instead of appearing
 * in one frame.
 */
const MessageOutlineBody = styled(Scrollbar).attrs<{
  $expanded: boolean
  $scrollbarVisible: boolean
  'data-expanded'?: 'true' | 'false'
  'data-outline-scrollbar'?: 'visible' | 'hidden'
}>((props) => ({
  'data-expanded': props.$expanded ? 'true' : 'false',
  'data-outline-scrollbar': props.$scrollbarVisible ? 'visible' : 'hidden'
}))`
   max-width: min(${OUTLINE_MAX_WIDTH_PX}px, calc(100% - ${OUTLINE_MAX_WIDTH_INSET_PX}px));
   max-height: min(100%, 45vh, 420px);
   align-self: center;
   flex: 0 1 auto;
   overflow-x: hidden;
   overflow-y: hidden;
   display: inline-flex;
   flex-direction: column;
   padding: ${BODY_INLINE_PADDING_PX}px 0 ${BODY_INLINE_PADDING_PX}px ${BODY_INLINE_PADDING_PX}px;
   border-radius: 10px;
   pointer-events: auto;
   background-color: transparent;
   box-shadow: 0 0 10px 0 rgba(128, 128, 128, 0);
   transition:
     padding ${EXPAND_TRANSITION_MS}ms ease-out,
     background-color ${EXPAND_TRANSITION_MS}ms ease-out,
     box-shadow ${EXPAND_TRANSITION_MS}ms ease-out;
  /**
   * Scoped to this body: the app's scrollbars stay classic and untouched, and
   * only this one element withholds its paint (see the reveal delay constant).
   * overflow-y is deliberately NOT part of it — the switch is a width
   * transition of this box, so the bar would be carried across the opening panel
   * instead of appearing on its final edge. Keeping the scroll container live
   * (auto) with its gutter reserved means the bar is merely invisible: scroll
   * range, client height and scrollTop are the same as when it is painted.
   *
   * The :hover arm is the specificity that matters: the shared Scrollbar paints
   * its thumb through the webkit scrollbar thumb pseudo-element and its own
   * :hover rule, so the withheld state has to out-specify both. transition: none
   * is the instant half — the shared component fades its thumb over 2s, and a
   * fade here would keep painting the bar for the whole of it, at whatever x it
   * had reached, which is the artifact being removed.
   */
  &[data-outline-scrollbar='hidden']::-webkit-scrollbar-thumb,
  &[data-outline-scrollbar='hidden']::-webkit-scrollbar-thumb:hover {
    background: transparent;
    transition: none;
  }
  &[data-expanded='true'] {
     padding: ${BODY_INLINE_PADDING_PX}px ${BODY_INLINE_PADDING_PX}px ${BODY_INLINE_PADDING_PX}px ${BODY_INLINE_PADDING_PX}px;
     overflow-y: auto;
     background-color: var(--color-background);
     box-shadow: 0 0 10px 0 rgba(128, 128, 128, 0.2);
     ${MessageOutlineContent} {
       gap: 4px;
     }
     ${MessageOutlineItem} {
       height: 24px;
     }
     ${MessageOutlineItemText} {
       opacity: 1;
     }
  // Fork marker row: the message-row height and the message-flow divider form —
  // the two rules flank the fork's text at the flow's 8px gap instead of
  // abutting. The rules grow, so they own the distribution: they reach the row's
  // two ends on a wide rail and keep their base size when the row is only as wide
  // as the label needs.
  ${MessageOutlineForkRow} {
    height: 24px;
    gap: ${FORK_ROW_GAP_PX}px;
  }
  ${MessageOutlineForkSegment} {
    width: auto;
    flex: 1 1 ${FORK_SEGMENT_BASIS_PX}px;
    min-width: ${FORK_SEGMENT_BASIS_PX}px;
  }
  ${MessageOutlineForkName} {
    max-width: ${OUTLINE_MAX_WIDTH_PX}px;
    opacity: 1;
  }
  }
  @media (prefers-reduced-motion: reduce) {
    transition: none;
    ${MessageOutlinePanel} {
      transition: none;
    }
    ${MessageOutlineContent} {
      transition: none;
    }
    ${MessageOutlineItem} {
      transition: none;
    }
    ${MessageOutlineItemText} {
      transition: none;
    }
    ${MessageOutlineItemDot} {
      transition: none;
    }
   ${MessageOutlineForkRow} {
     transition: none;
   }
   ${MessageOutlineForkSegment} {
     transition: none;
   }
   ${MessageOutlineForkName} {
     transition: none;
   }
  }
`

export default React.memo(MessageOutline)
