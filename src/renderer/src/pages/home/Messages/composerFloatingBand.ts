/**
 * Geometry of the composer-side floating control band.
 *
 * The composer's floating controls are portaled out of the composer's own
 * stacking context (see `TopicSegmentDrawer`), so they paint OVER the message
 * flow inside `#messages` instead of sharing a host with it: one inset gap
 * above the composer top, and one square box of their own.
 *
 * That makes the band a layout fact the conversation scroll content must
 * respect: the flow's last row ends on or above the band's top edge, so no flow
 * row is painted under the floating control. The folded group label is the
 * strictest case — its `24px` pill hangs at the top of the group's `32px`
 * header row, so only the row's own `8px` slack separates the pill from the
 * reserved band. The scroll content reserves exactly that band as its bottom
 * padding and the control is placed by the same numbers, so the two can never
 * drift apart again.
 */

/** Inset between the composer edge and the floating control (both axes). */
export const COMPOSER_FLOATING_CONTROL_INSET_PX = 8

/** Square size of the floating control. */
export const COMPOSER_FLOATING_CONTROL_SIZE_PX = 24

/**
 * Vertical band the floating control occupies above the composer top, i.e. the
 * clearance the scroll content tail must keep free.
 */
export const COMPOSER_FLOATING_CONTROL_BAND_PX = COMPOSER_FLOATING_CONTROL_INSET_PX + COMPOSER_FLOATING_CONTROL_SIZE_PX
