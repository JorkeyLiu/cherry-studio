/**
 * Group-head ownership — the single mutation-authority helper (pure, no DOM).
 *
 * `isGroupHeadOwnedByRoute` compares the Main-resolved stable head owner
 * against the addressed route (topic AND branch). Fail-closed: missing owner
 * metadata is never owned. A head that is absent from the window (or the
 * route) does NOT change ownership — absence only affects reachability
 * (`headerInRoute`), decided separately. Read and navigation stay available
 * on non-owner routes; only metadata/membership mutation is gated.
 */
import { describe, expect, it } from 'vitest'

import { isGroupHeadOwnedByRoute } from '../routeAnswerGroup'

describe('isGroupHeadOwnedByRoute', () => {
  it('owns the main route when the head owner is the topic with a null branch', () => {
    expect(isGroupHeadOwnedByRoute({ ownerTopicId: 't1', ownerBranchId: null }, 't1', null)).toBe(true)
  })

  it('owns a branch route on exact topic AND branch equality', () => {
    expect(isGroupHeadOwnedByRoute({ ownerTopicId: 't1', ownerBranchId: 'b-1' }, 't1', 'b-1')).toBe(true)
  })

  it('refuses a sibling branch (same topic, different branch)', () => {
    expect(isGroupHeadOwnedByRoute({ ownerTopicId: 't1', ownerBranchId: 'b-1' }, 't1', 'b-2')).toBe(false)
  })

  it('refuses the main route for a branch-owned head', () => {
    expect(isGroupHeadOwnedByRoute({ ownerTopicId: 't1', ownerBranchId: 'b-1' }, 't1', null)).toBe(false)
  })

  it('refuses a foreign topic even on the same branch id', () => {
    expect(isGroupHeadOwnedByRoute({ ownerTopicId: 't9', ownerBranchId: null }, 't1', null)).toBe(false)
  })

  it('fails closed without owner metadata (legacy payload without a head contract)', () => {
    expect(isGroupHeadOwnedByRoute({}, 't1', null)).toBe(false)
    expect(isGroupHeadOwnedByRoute({ ownerBranchId: null }, 't1', null)).toBe(false)
    expect(isGroupHeadOwnedByRoute({ ownerTopicId: 't1' }, 't1', null)).toBe(false)
  })

  it('fails closed on a null or undefined segment', () => {
    expect(isGroupHeadOwnedByRoute(null, 't1', null)).toBe(false)
    expect(isGroupHeadOwnedByRoute(undefined, 't1', null)).toBe(false)
  })
})
