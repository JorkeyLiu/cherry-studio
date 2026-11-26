/**
 * Shared navigation-rail axis geometry.
 *
 * Single source for the horizontal axis the MessageOutline compact rail's
 * level-1 dash is visually centered on, and the bottom drawer trigger
 * alignment derived from it. Both surfaces share the chat-column origin, so
 * the trigger's in-flow anchor is shifted left by exactly the gap between
 * the two centers — never by a duplicated magic offset.
 *
 * Static CSS provenance (no measurement subscriptions):
 * - Rail center: `NAV_GUTTER_INSET_PX` (outline container left inset) +
 *   `NAV_RAIL_BODY_INLINE_PAD_PX` (outline body left padding) + half of the
 *   level-1 dot (`16 - 1 * 2 = 14px` wide, see `MessageOutlineItemDot`) =
 *   10 + 10 + 7 = 27. The halo's padding/margin pair nets to zero, so it
 *   contributes nothing. Matches the inspector-measured rail center.
 * - Drawer center (unaligned): `INPUTBAR_OUTER_SIDE_PAD_PX` (InputbarCore
 *   outer container side padding) + `COMPOSER_FLOATING_CONTROL_INSET_PX`
 *   (in-flow anchor left inside the input container) + half of
 *   `COMPOSER_FLOATING_CONTROL_SIZE_PX` = 18 + 8 + 12 = 38. Matches the
 *   inspector-measured drawer center (11px right of the rail).
 * - Alignment shift: 38 - 27 = 11, applied as a leftward move of the
 *   anchor only while the navigation rail is mounted (`messageNavigation`
 *   on). With navigation off the anchor keeps its historical inset and the
 *   drawer keeps its existing availability.
 */

import { COMPOSER_FLOATING_CONTROL_INSET_PX, COMPOSER_FLOATING_CONTROL_SIZE_PX } from './composerFloatingBand'

/** Outline container left inset inside the navigation gutter. */
export const NAV_GUTTER_INSET_PX = 10

/** Outline body left padding the compact rail sits inside. */
export const NAV_RAIL_BODY_INLINE_PAD_PX = 10

/** Half of the level-1 compact dot width (`16 - 1 * 2 = 14px`). */
export const NAV_RAIL_DOT_HALF_PX = 7

/**
 * Visual center of the compact rail's dash, from the shared chat-column
 * origin: gutter inset + body padding + dot half.
 */
export const NAV_RAIL_AXIS_PX = NAV_GUTTER_INSET_PX + NAV_RAIL_BODY_INLINE_PAD_PX + NAV_RAIL_DOT_HALF_PX

/** InputbarCore outer container side (and bottom) padding. */
export const INPUTBAR_OUTER_SIDE_PAD_PX = 18

/** Half of the floating control box both the anchor and trigger share. */
export const DRAWER_TRIGGER_HALF_PX = COMPOSER_FLOATING_CONTROL_SIZE_PX / 2

/**
 * Leftward shift of the drawer anchor while navigation is on: the gap
 * between the unaligned drawer center and the rail axis.
 */
export const TOPIC_SEGMENT_DRAWER_NAV_ALIGN_SHIFT_PX =
  INPUTBAR_OUTER_SIDE_PAD_PX + COMPOSER_FLOATING_CONTROL_INSET_PX + DRAWER_TRIGGER_HALF_PX - NAV_RAIL_AXIS_PX

/**
 * In-flow anchor left inside the input container. Navigation on moves the
 * anchor left by the shared shift so the portaled trigger lands on the rail
 * axis; navigation off keeps the historical inset byte-for-byte.
 */
export const resolveTopicSegmentDrawerAnchorLeft = (navigationOn: boolean): number =>
  navigationOn
    ? COMPOSER_FLOATING_CONTROL_INSET_PX - TOPIC_SEGMENT_DRAWER_NAV_ALIGN_SHIFT_PX
    : COMPOSER_FLOATING_CONTROL_INSET_PX
