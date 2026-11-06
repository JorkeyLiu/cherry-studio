import Scrollbar from '@renderer/components/Scrollbar'
import type { FC, KeyboardEvent } from 'react'
import React, { Fragment, useCallback, useEffect, useRef, useState } from 'react'
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
 * Expand/collapse transition: collapsed rows are 12px high with a 2px gap;
 * expansion grows rows to 24px with a 4px gap over 180ms ease-out. The
 * ResizeObserver follow below re-measures at the final actual size, so
 * expansion needs no timer of its own; only leaving needs the grace below.
 */
const EXPAND_TRANSITION_MS = 180

/**
 * Collapse grace margin: expansion is immediate, but the collapsed rail is
 * only ~24px wide, so shrinking the moment the pointer left made it trivial
 * to drop the panel while travelling. Leaving waits this margin first.
 */
const COLLAPSE_GRACE_MS = 160

/**
 * Follow safe-zone band: the active row moves the outline only when its
 * center leaves this middle fraction of the container height.
 */
const FOLLOW_SAFE_ZONE_TOP_RATIO = 0.2
const FOLLOW_SAFE_ZONE_BOTTOM_RATIO = 0.8
/**
 * Edge-band floor in row heights: the 20% inset never shrinks below ~1.5
 * rows, so small containers keep an early-follow band instead of riding the
 * edge. Short lists without overflow never scroll (guarded in the effect).
 */
const FOLLOW_SAFE_MIN_MARGIN_ROWS = 1.5

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
 * Collapsed rows are 12px high with a 2px body gap; entering the body
 * expands (180ms ease-out) to the original 24px row / 4px gap / dot-text 8px
 * geometry and leaving restores the collapsed rail after a short grace, with
 * DOM, positioning, single-line ellipsis, trigger area and navigation
 * behavior unchanged.
 * $level props stay because dot size/padding still use them.
 * prefers-reduced-motion disables all transitions.
 * A fork marker (`forkAfter`) is a separate NON-interactive row inserted
 * directly after the marked message row: it is never a navigation target (no
 * role, stable id, tab stop, handler or active highlight), so the marked
 * message row keeps its own hitbox and stays reachable. Its row height matches
 * the message rows exactly (12px collapsed / 24px expanded, same body gap), so
 * collapsed and expanded rows line up 1:1.
 * Collapsed it is two 6px dashes with a 2px gap — 14px total, exactly the dot
 * band it sits in — and carries no text at all. Expanded it becomes
 * `── <text> ──` in the message flow's divider form: two 1px `flex:1` rules, an
 * 8px gap and the fork's label in the middle, left-aligned with the dot column.
 * The text is the message flow's own two states (`forkMarkerLabel`): the branch
 * this route travels at the fork, or the fork's `此处有 {{count}} 条分支` count
 * when the route took none — a fork is never drawn as a bare line. No caret:
 * the flow's `▾` belongs to a clickable popover trigger, and this row is not
 * interactive. The text is rendered only while expanded, so the collapsed
 * marker carries no text in the DOM rather than merely hiding it.
 *
 * Active highlight (`activeId`) is theme-colored with `aria-current` and the
 * outline container follows it edge-early: when the active row's center
 * leaves the middle safe-zone band (20%-80% of the container height, at
 * least ~1.5 rows inset) or is out of view, only the outline container's
 * own scrollTop moves so the row recenters — never `scrollIntoView`, which
 * would move the chat.
 * Manual wheel/pointer/key interaction pauses follow until a short idle
 * window passes; drag releases on document `pointerup`.
 */
const MessageOutline: FC<MessageOutlineProps> = ({ entries, onNavigate, activeId, forkAfter }) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const followPausedRef = useRef(false)
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafRef = useRef<number | null>(null)
  // Expansion is a JS state machine (not CSS :hover) so leaving can wait for
  // COLLAPSE_GRACE_MS while entering stays immediate.
  const [expanded, setExpanded] = useState(false)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleResume = useCallback(() => {
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current)
      resumeTimerRef.current = null
    }
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null
      followPausedRef.current = false
    }, FOLLOW_RESUME_IDLE_MS)
  }, [])

  const pauseFollow = useCallback(() => {
    followPausedRef.current = true
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    scheduleResume()
  }, [scheduleResume])

  // Drag release anywhere releases the pause via the idle window; RAF and
  // timers are cleaned up on unmount.
  useEffect(() => {
    const handlePointerUp = () => {
      if (followPausedRef.current) scheduleResume()
    }
    document.addEventListener('pointerup', handlePointerUp)
    return () => {
      document.removeEventListener('pointerup', handlePointerUp)
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
    }
  }, [scheduleResume])

  // Container-local edge-early follow: when the active row's center is out
  // of view or inside an edge band (outside the middle 20%-80% safe zone,
  // at least ~1.5 rows inset), move only the outline container's own
  // scrollTop so the row centers. The browser clamps scrollTop at the
  // content ends, so first/last rows rest at the boundary instead of
  // centering. Rows resting in the safe zone never move the outline.
  // The target is always the reading anchor — never the hovered row — so
  // expansion can never scroll to a wrong item.
  const recenterToActiveRow = useCallback((targetId: string) => {
    if (followPausedRef.current) return
    const container = containerRef.current
    if (!container) return
    // Attribute-value match instead of a selector query: stable IDs never
    // pass through the selector parser (no CSS.escape dependency).
    const row = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (el) => el.dataset.messageId === targetId
    )
    if (!row) return
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const containerHeight = containerRect.height || containerRect.bottom - containerRect.top
    if (containerHeight <= 0) return
    const rowHeight = rowRect.height || rowRect.bottom - rowRect.top
    const rowFloor = FOLLOW_SAFE_MIN_MARGIN_ROWS * Math.max(rowHeight, 0)
    const topMargin = Math.max(containerHeight * FOLLOW_SAFE_ZONE_TOP_RATIO, rowFloor)
    const bottomMargin = Math.max(containerHeight * (1 - FOLLOW_SAFE_ZONE_BOTTOM_RATIO), rowFloor)
    const safeTop = containerRect.top + topMargin
    const safeBottom = containerRect.bottom - bottomMargin
    const rowCenter = (rowRect.top + rowRect.bottom) / 2
    const outOfView = rowRect.bottom <= containerRect.top || rowRect.top >= containerRect.bottom
    // No scrollable overflow (short list): centering is meaningless.
    if (container.scrollHeight <= container.clientHeight + 1) return
    if (outOfView || rowCenter < safeTop || rowCenter > safeBottom) {
      const containerCenter = (containerRect.top + containerRect.bottom) / 2
      container.scrollTop += rowCenter - containerCenter
    }
  }, [])

  useEffect(() => {
    if (!activeId || followPausedRef.current) return
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      recenterToActiveRow(activeId)
    })
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [activeId, entries, recenterToActiveRow])

  // Keep the active row visible across the expand/collapse height change: a
  // ResizeObserver re-runs the same RAF follow schedule, so the edge-band
  // geometry is always measured at the final actual size (transition
  // intermediates converge there). Scrolling never resizes content, so this
  // cannot self-trigger.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !activeId) return
    if (typeof ResizeObserver === 'undefined') return
    let raf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => recenterToActiveRow(activeId))
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [activeId, recenterToActiveRow])

  if (!entries.length) return null

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onNavigate(id)
    }
  }

  // Entering expands at once, replacing the CSS :hover it used to rely on.
  const handleBodyMouseEnter = () => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current)
      collapseTimerRef.current = null
    }
    setExpanded(true)
  }

  // Leaving only starts the collapse; the grace margin above is the travel
  // slack for a pointer that crosses the thin collapsed rail.
  const handleBodyMouseLeave = () => {
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current)
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null
      setExpanded(false)
    }, COLLAPSE_GRACE_MS)
  }

  return (
    <MessageOutlineContainer data-testid="conversation-navigation">
      <MessageOutlineBody
        ref={containerRef}
        $expanded={expanded}
        onMouseEnter={handleBodyMouseEnter}
        onMouseLeave={handleBodyMouseLeave}
        onWheel={pauseFollow}
        onPointerDown={pauseFollow}
        onKeyDownCapture={pauseFollow}>
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
                popover trigger, and this row is not interactive). The text is
                rendered ONLY while expanded, so the collapsed marker is exactly
                two dashes with no text in the DOM — and it is always present,
                because the caller supplies the flow's untaken-fork count form
                when the route took no branch here.
              */}
              {hasFork ? (
                <MessageOutlineForkRow aria-hidden="true" data-testid="conversation-nav-fork" key={`fork-${entry.id}`}>
                  <MessageOutlineForkSegment />
                  {expanded ? <MessageOutlineForkName>{forkText}</MessageOutlineForkName> : null}
                  <MessageOutlineForkSegment />
                </MessageOutlineForkRow>
              ) : null}
            </Fragment>
          )
        })}
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

const MessageOutlineItemText = styled.div<{ $level: number; $miniLevel: number }>`
  overflow: hidden;
  color: var(--color-text-3);
  opacity: 0;
  display: none;
  transition: opacity 0.2s ease;
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
 * Fork marker row: the same height as a message row in both states (12px
 * collapsed / 24px expanded) and the body owns the shared row gap, so the
 * collapsed and expanded lists line up row for row.
 *
 * Collapsed it occupies exactly the dot band — 6px + 2px gap + 6px = 14px,
 * the dot's own width — so the dashes read as one short interruption of the
 * rail instead of two separated strokes. Expanded it stretches across the
 * content width and hosts the fork's label (branch name or count form) between
 * its two rules.
 * Not interactive: no cursor, no hover state.
 */
const MessageOutlineForkRow = styled.div`
  height: 12px;
  width: 14px;
  align-self: flex-start;
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  pointer-events: none;
  transition:
    height ${EXPAND_TRANSITION_MS}ms ease-out,
    gap ${EXPAND_TRANSITION_MS}ms ease-out;
`
/**
 * One dash. Collapsed it is a 6px stroke with the dot's 2px radius; expanded it
 * drops its fixed width and takes an equal share of the row, so the two
 * surviving rules read as the dividers around the name — the same 1px
 * `var(--color-border)` line the message-flow fork divider draws.
 */
const MessageOutlineForkSegment = styled.div`
  width: 6px;
  height: 1px;
  background: var(--color-border);
  border-radius: 2px;
  flex: 0 0 auto;
  transition: width ${EXPAND_TRANSITION_MS}ms ease-out;
`
/**
 * The fork's label between the two rules: the message-flow divider's text form
 * (11.5px, secondary text color) at the flow's 8px gap. It never wraps or
 * shrinks, so the rules absorb every width change around it.
 */
const MessageOutlineForkName = styled.div`
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--color-text-2);
  white-space: nowrap;
`
/**
 * `$expanded` is a transient prop (styled-components never forwards it to the
 * DOM); it is projected onto `data-expanded` so the expanded geometry stays a
 * static CSS rule instead of a per-render dynamic interpolation.
 */
const MessageOutlineBody = styled(Scrollbar).attrs<{
  $expanded: boolean
  'data-expanded'?: 'true' | 'false'
}>((props) => ({ 'data-expanded': props.$expanded ? 'true' : 'false' }))`
   max-width: min(320px, calc(100% - 24px));
   max-height: min(100%, 45vh, 420px);
   align-self: center;
   flex: 0 1 auto;
   overflow-x: hidden;
   overflow-y: hidden;
   display: inline-flex;
   flex-direction: column;
   padding: 10px 0 10px 10px;
   gap: 2px;
   border-radius: 10px;
   pointer-events: auto;
   transition:
     gap ${EXPAND_TRANSITION_MS}ms ease-out,
     padding ${EXPAND_TRANSITION_MS}ms ease-out;
  &[data-expanded='true'] {
     padding: 10px 10px 10px 10px;
     gap: 4px;
     overflow-y: auto;
     background: var(--color-background);
     box-shadow: 0 0 10px 0 rgba(128, 128, 128, 0.2);
     ${MessageOutlineItem} {
       height: 24px;
     }
     ${MessageOutlineItemText} {
       opacity: 1;
       display: block;
     }
    // Fork marker row: the message-row height, the full content width, and the
    // message-flow divider form — the two rules flank the fork's text at the
    // flow's 8px gap instead of abutting, so the marker always reads as the
    // same divider the message stream draws.
    ${MessageOutlineForkRow} {
      height: 24px;
      width: auto;
      align-self: stretch;
      gap: 8px;
    }
    ${MessageOutlineForkSegment} {
      width: auto;
      flex: 1 1 0;
    }
   }
   @media (prefers-reduced-motion: reduce) {
     transition: none;
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
   }
 `

export default React.memo(MessageOutline)
