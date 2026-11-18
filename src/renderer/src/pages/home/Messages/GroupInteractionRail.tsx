import { styled } from 'styled-components'

/**
 * Shared interaction-rail primitives extracted from the message-group edge
 * (`TopicSegmentLine`: `GroupRail` / `RailLine` / `RailHitTarget`).
 *
 * This file owns the ONLY stroke / hit / hover / focus styling for group and
 * fold rails:
 * - visible line: 2px wide (`INTERACTION_RAIL_LINE_WIDTH_PX`), square ends,
 *   idle color via `$color`, hover/focus highlight is line-only (the group's
 *   own brightness lift by default, an optional `$activeColor` when the caller
 *   must read differently) — never a width change, never a background band,
 *   never a tooltip.
 * - hit target: transparent 8px (`INTERACTION_RAIL_HIT_WIDTH_PX`) overlay,
 *   the only keyboard focus outline.
 *
 * Semantics stay with the caller: the group rail opens the group menu while
 * the fold rail expands/collapses the browse view. Neither behavior nor any
 * tooltip lives here.
 */

export const INTERACTION_RAIL_LINE_WIDTH_PX = 2
export const INTERACTION_RAIL_HIT_WIDTH_PX = 8
/**
 * Transverse outset of every rail box from its host body edge. It matches the
 * only available gutter — the flow ScrollContainer's own `padding-left: 10px`
 * — so the 2px line (left-aligned in its box, never centered) plus the 8px
 * hit target (overflowing rightward only) both paint inside the scrollport
 * without touching `overflow-x` or message-body x. One constant, every
 * group/continuation/fold base reads it.
 */
export const INTERACTION_RAIL_OUTSET_PX = 10

export const INTERACTION_RAIL_COLLAPSED_HEIGHT_PX = 20

/**
 * The rail's painted line. Same geometry as the group rail: 2px wide, square
 * ends. `$active` is the single hover/focus state of the owning region.
 *
 * - Without `$activeColor` the active lift stays the group's own brightness
 *   rule (group behavior unchanged).
 * - With `$activeColor` the active state paints that color instead, so a
 *   caller that must read differently from the group (the fold block) gets a
 *   clearly visible feedback without touching the group contract.
 * Width never changes with the state; the line is an explicit block box so
 * its 2px geometry never depends on inline sizing.
 */
export const InteractionRailLine = styled.div<{ $color: string; $active: boolean; $activeColor?: string }>`
   display: block;
   box-sizing: border-box;
   position: absolute;
   inset: 0;
   width: ${INTERACTION_RAIL_LINE_WIDTH_PX}px;
   background-color: ${(props) => (props.$active && props.$activeColor ? props.$activeColor : props.$color)};
   filter: ${(props) => (props.$active && !props.$activeColor ? 'brightness(1.35)' : 'none')};
   transition:
     filter 0.15s ease,
     background-color 0.15s ease;

   @media (prefers-reduced-motion: reduce) {
     transition: none;
   }
 `

/**
 * Transparent hit target laid exactly over the rail line (2px) plus 6px of
 * adjacent gutter. It paints nothing on hover: the visible affordance stays
 * the ONE line brightening above. Keyboard focus keeps its own outline.
 */
export const InteractionRailHitTarget = styled.button`
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: ${INTERACTION_RAIL_HIT_WIDTH_PX}px;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  z-index: 1;

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
`
