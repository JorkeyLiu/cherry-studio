/**
 * F1: the legacy topic-only (`scroll:topic-<id>`) read applies the same
 * coordinate-space gate as the hook. A foreign (untagged, pre-flow) record
 * can never contribute numeric offsets to a placement plan: anchorless
 * foreign numbers are absent, so plan selection defaults to bottom/latest.
 * Stable anchors/offsets, bottom classification, and tagged flow-v1 numbers
 * survive the gate.
 */
import type { SavedScrollPosition } from '@renderer/hooks/useScrollPosition'
import { normalizeSaved } from '@renderer/hooks/useScrollPosition'
import { FLOW_COORDINATE_SPACE } from '@renderer/pages/home/Messages/flowScrollGeometry'
import { chooseRouteWindowRequest, chooseTopFirstPositionPlan } from '@renderer/pages/home/Messages/messageWindow'
import { describe, expect, it } from 'vitest'

/** The production call sites recast the gated record to the plan input shape. */
const asPlanInput = (gated: SavedScrollPosition | null) =>
  gated as {
    scrollTop: number
    anchorId: string | null
    messageId?: string | null
    intraRowOffset?: number | null
    rawScrollTop?: number
    isAtBottom: boolean
  } | null

describe('legacy main saved-position gate (F1)', () => {
  it('drops untagged negative anchorless numbers → bottom/latest default', () => {
    const gated = normalizeSaved({ scrollTop: -300, rawScrollTop: -300, anchorId: null, isAtBottom: false })
    expect(gated).not.toBeNull()
    expect(gated?.scrollTop).toBeUndefined()
    expect(gated?.rawScrollTop).toBeUndefined()
    expect(gated?.anchorId).toBeNull()
    expect(gated?.isAtBottom).toBe(false)
    // No anchor and no numbers: the window read is latest, placement is bottom.
    expect(chooseRouteWindowRequest(asPlanInput(gated))).toEqual({ kind: 'latest' })
    expect(
      chooseTopFirstPositionPlan({
        saved: asPlanInput(gated),
        snapshotInvalidForRoute: false,
        routeSavedRowAnchor: null
      })
    ).toEqual({ kind: 'bottom' })
  })

  it('preserves untagged stable anchor, offset, and bottom classification', () => {
    const gated = normalizeSaved({
      scrollTop: -1200,
      rawScrollTop: -1200,
      anchorId: 'm-keep',
      messageId: 'm-keep',
      intraRowOffset: -51,
      isAtBottom: false
    })
    expect(gated?.anchorId).toBe('m-keep')
    expect(gated?.messageId).toBe('m-keep')
    expect(gated?.intraRowOffset).toBe(-51)
    expect(gated?.isAtBottom).toBe(false)
    expect(gated?.scrollTop).toBeUndefined()
    expect(gated?.rawScrollTop).toBeUndefined()
    // The exact anchor still selects its around read and message placement.
    expect(chooseRouteWindowRequest(asPlanInput(gated))).toEqual({ kind: 'around', anchorMessageId: 'm-keep' })
    expect(
      chooseTopFirstPositionPlan({
        saved: asPlanInput(gated),
        snapshotInvalidForRoute: false,
        routeSavedRowAnchor: 'm-keep'
      })
    ).toEqual({ kind: 'message', messageId: 'm-keep', wantOffset: -51, fallbackScrollTop: null })
  })

  it('keeps tagged flow-v1 numbers intact', () => {
    const gated = normalizeSaved({
      scrollTop: 4990,
      rawScrollTop: 4990,
      anchorId: null,
      messageId: null,
      intraRowOffset: null,
      isAtBottom: true,
      coordinateSpace: FLOW_COORDINATE_SPACE
    })
    expect(gated?.scrollTop).toBe(4990)
    expect(gated?.rawScrollTop).toBe(4990)
    expect(gated?.isAtBottom).toBe(true)
    expect(
      chooseTopFirstPositionPlan({
        saved: asPlanInput(gated),
        snapshotInvalidForRoute: false,
        routeSavedRowAnchor: null
      })
    ).toEqual({ kind: 'bottom' })
  })

  it('treats a legacy plain number as anchorless absent → bottom/latest default', () => {
    const gated = normalizeSaved(-500)
    expect(gated?.scrollTop).toBeUndefined()
    expect(gated?.anchorId).toBeNull()
    expect(gated?.messageId).toBeNull()
    expect(gated?.isAtBottom).toBe(false)
    expect(chooseRouteWindowRequest(asPlanInput(gated))).toEqual({ kind: 'latest' })
    expect(
      chooseTopFirstPositionPlan({
        saved: asPlanInput(gated),
        snapshotInvalidForRoute: false,
        routeSavedRowAnchor: null
      })
    ).toEqual({ kind: 'bottom' })
  })
})
