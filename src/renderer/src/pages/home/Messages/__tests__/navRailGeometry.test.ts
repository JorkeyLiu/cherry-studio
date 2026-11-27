import { describe, expect, it } from 'vitest'

import { COMPOSER_FLOATING_CONTROL_INSET_PX } from '../composerFloatingBand'
import {
  DRAWER_TRIGGER_HALF_PX,
  INPUTBAR_OUTER_SIDE_PAD_PX,
  NAV_GUTTER_INSET_PX,
  NAV_RAIL_AXIS_PX,
  NAV_RAIL_BODY_INLINE_PAD_PX,
  NAV_RAIL_DOT_HALF_PX,
  resolveTopicSegmentDrawerAnchorLeft,
  resolveTopicSegmentDrawerCanvasLeft,
  TOPIC_SEGMENT_DRAWER_NAV_ALIGN_SHIFT_PX
} from '../navRailGeometry'

/**
 * Rail/drawer alignment is relational, never a mirrored literal: every
 * assertion derives one shared export from the others, so a geometry change
 * that moves both sides together stays green and only a drift between them
 * fails.
 */
describe('navRailGeometry shared axis', () => {
  it('builds the rail axis from the gutter inset, body padding and dot half', () => {
    expect(NAV_RAIL_AXIS_PX).toBe(NAV_GUTTER_INSET_PX + NAV_RAIL_BODY_INLINE_PAD_PX + NAV_RAIL_DOT_HALF_PX)
  })

  it('builds the drawer shift from the unaligned center minus the rail axis', () => {
    const unalignedDrawerCenter =
      INPUTBAR_OUTER_SIDE_PAD_PX + COMPOSER_FLOATING_CONTROL_INSET_PX + DRAWER_TRIGGER_HALF_PX
    expect(TOPIC_SEGMENT_DRAWER_NAV_ALIGN_SHIFT_PX).toBe(unalignedDrawerCenter - NAV_RAIL_AXIS_PX)
    expect(TOPIC_SEGMENT_DRAWER_NAV_ALIGN_SHIFT_PX).toBeGreaterThan(0)
  })

  it('lands the aligned trigger center exactly on the rail axis', () => {
    const alignedCenter =
      resolveTopicSegmentDrawerAnchorLeft(true) + INPUTBAR_OUTER_SIDE_PAD_PX + DRAWER_TRIGGER_HALF_PX
    expect(alignedCenter).toBe(NAV_RAIL_AXIS_PX)
  })

  it('preserves the historical inset byte-for-byte with navigation off', () => {
    expect(resolveTopicSegmentDrawerAnchorLeft(false)).toBe(COMPOSER_FLOATING_CONTROL_INSET_PX)
  })

  it('moves the anchor left (toward the rail) while navigation is on', () => {
    expect(resolveTopicSegmentDrawerAnchorLeft(true)).toBeLessThan(resolveTopicSegmentDrawerAnchorLeft(false))
  })

  it('places the fixed canvas drawer trigger on the rail axis when navigation is on', () => {
    expect(resolveTopicSegmentDrawerCanvasLeft(true) + DRAWER_TRIGGER_HALF_PX).toBe(NAV_RAIL_AXIS_PX)
    expect(resolveTopicSegmentDrawerCanvasLeft(false)).toBe(INPUTBAR_OUTER_SIDE_PAD_PX)
  })
})
