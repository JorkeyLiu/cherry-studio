import { describe, expect, it } from 'vitest'

import {
  claimPaginationFetchLease,
  createPaginationFetchLease,
  isPaginationFetchLeaseFree,
  ownsPaginationFetchLease,
  releasePaginationFetchLease
} from '../paginationFetchLease'

describe('pagination fetch lease (token-scoped ownership)', () => {
  it('claims a free lease exactly once', () => {
    const lease = createPaginationFetchLease()
    const first = {}
    const second = {}
    expect(isPaginationFetchLeaseFree(lease)).toBe(true)
    expect(claimPaginationFetchLease(lease, first)).toBe(true)
    expect(isPaginationFetchLeaseFree(lease)).toBe(false)
    // A claimant never evicts the current owner.
    expect(claimPaginationFetchLease(lease, second)).toBe(false)
    expect(ownsPaginationFetchLease(lease, first)).toBe(true)
    expect(ownsPaginationFetchLease(lease, second)).toBe(false)
  })

  it('releases ownership-scoped: a superseded attempt cannot free its successor', () => {
    const lease = createPaginationFetchLease()
    const attemptA = {}
    const attemptB = {}
    expect(claimPaginationFetchLease(lease, attemptA)).toBe(true)
    // A is cancelled/dropped by a teardown path: the lease is force-released.
    expect(releasePaginationFetchLease(lease)).toBe(true)
    expect(claimPaginationFetchLease(lease, attemptB)).toBe(true)
    // A's late continuation releases "its" ownership only — B keeps the lease,
    // so a third read can never start concurrently with B.
    releasePaginationFetchLease(lease, attemptA)
    expect(ownsPaginationFetchLease(lease, attemptB)).toBe(true)
    expect(isPaginationFetchLeaseFree(lease)).toBe(false)
    // B itself can still release.
    releasePaginationFetchLease(lease, attemptB)
    expect(isPaginationFetchLeaseFree(lease)).toBe(true)
  })

  it('ignores a superseded attempt releasing after a reset-style ownership drop', () => {
    const lease = createPaginationFetchLease()
    const token = {}
    claimPaginationFetchLease(lease, token)
    // Topic reset/eviction style: ownership dropped without a token identity.
    releasePaginationFetchLease(lease)
    expect(isPaginationFetchLeaseFree(lease)).toBe(true)
    // The stale attempt's own release is a no-op on an already-free lease.
    releasePaginationFetchLease(lease, token)
    expect(isPaginationFetchLeaseFree(lease)).toBe(true)
    expect(ownsPaginationFetchLease(lease, null)).toBe(false)
  })
})
