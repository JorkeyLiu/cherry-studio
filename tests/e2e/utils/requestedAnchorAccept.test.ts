import { describe, expect, it } from 'vitest'

import { decideRequestedAnchorAcceptance } from './requestedAnchorAccept'

describe('decideRequestedAnchorAcceptance', () => {
  it('accepts the B-return shape: requested row restored within tolerance while a neighbour is crossing-first', () => {
    // Forensics: requested 00005 have +0.13 vs want -0.11 (residual 0.239);
    // neighbour 00004 sits at -62.87 and legitimately wins crossing-first.
    expect(decideRequestedAnchorAcceptance(-0.11, { count: 1, visible: true, offset: 0.13 })).toEqual({ ok: true })
  })

  it('fails a present-but-drifted requested row (63px offset)', () => {
    expect(decideRequestedAnchorAcceptance(0, { count: 1, visible: true, offset: 63 })).toEqual({
      ok: false,
      reason: 'offset-drift'
    })
  })

  it('fails a missing requested row', () => {
    expect(decideRequestedAnchorAcceptance(0, { count: 0, visible: false, offset: null })).toEqual({
      ok: false,
      reason: 'not-resident'
    })
  })

  it('fails an invisible requested row', () => {
    expect(decideRequestedAnchorAcceptance(0, { count: 1, visible: false, offset: 0 })).toEqual({
      ok: false,
      reason: 'not-visible'
    })
  })

  it('holds the 12px boundary: 12 passes, 12.001 fails', () => {
    expect(decideRequestedAnchorAcceptance(0, { count: 1, visible: true, offset: 12 })).toEqual({ ok: true })
    expect(decideRequestedAnchorAcceptance(0, { count: 1, visible: true, offset: 12.001 })).toEqual({
      ok: false,
      reason: 'offset-drift'
    })
  })
})
