// Requested-anchor acceptance decision for true-branch strict viewport restore.
//
// ADR VIEWPORT-5: a TOP hidden-restore commits WithAnchor(requested id, want)
// once the requested anchor row is resident. The strict E2E oracle must
// therefore measure the REQUESTED row's geometry (row.top - container.top
// versus the departure offset), not the crossing-first row identity: a
// neighbour row 1px over the container top legitimately becomes the
// crossing-first anchor while the requested row itself is restored within
// tolerance. Threshold (12px) is unchanged product semantics.
export const REQUESTED_ANCHOR_TOLERANCE_PX = 12

export type RequestedAnchorMeasurement = {
  /** Resident DOM rows carrying the requested data-message-id. */
  count: number
  /** Whether the requested row intersects the #messages viewport. */
  visible: boolean
  /** Requested row top minus #messages container top, in px. Null when absent. */
  offset: number | null
}

export type RequestedAnchorAcceptance =
  | { ok: true }
  | { ok: false; reason: 'not-resident' | 'not-visible' | 'offset-drift' }

export function decideRequestedAnchorAcceptance(
  beforeOffset: number,
  measured: RequestedAnchorMeasurement,
  tolerancePx: number = REQUESTED_ANCHOR_TOLERANCE_PX
): RequestedAnchorAcceptance {
  if (measured.count !== 1) return { ok: false, reason: 'not-resident' }
  if (!measured.visible) return { ok: false, reason: 'not-visible' }
  if (measured.offset === null) return { ok: false, reason: 'not-resident' }
  if (Math.abs(measured.offset - beforeOffset) > tolerancePx) return { ok: false, reason: 'offset-drift' }
  return { ok: true }
}
