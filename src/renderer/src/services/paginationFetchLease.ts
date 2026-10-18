/**
 * Token-scoped single-owner lease for one synchronous ordinary page fetch.
 *
 * The bidirectional pagination path keeps at most one in-flight ordinary read
 * for the current topic/route, shared by both directions: ownership is the
 * REQUEST TOKEN, never a bare boolean, because an attempt that was superseded or
 * cancelled must not release the lease its successor holds — otherwise a third
 * request could start concurrently and two responses would race for the same
 * resident projection (the loser would publish an order computed from a
 * projection the winner already replaced).
 *
 * Semantics:
 * - `claim` succeeds only when the lease is free (an owner is never evicted by
 *   a claimant; a successor is started only after an explicit release).
 * - `release` with a token is ownership-scoped: a non-owner release is a no-op.
 * - `release` without a token is a forced release, used only by teardown /
 *   invalidation paths that drop the whole attempt (unmount, deletion
 *   invalidation, topic transition, cancel-all).
 *
 * A refused claim never records intent: the very next edge event (or the restore
 * owner's next step) claims the released lease, so continued browsing is never
 * silently dropped.
 *
 * Renderer-local, synchronous and disposable: no persistence, no
 * cross-process state, no queue, no lifecycle subsystem.
 */
export interface PaginationFetchLease {
  /** Owning request token, or `null` when no attempt holds the lease. */
  owner: object | null
}

/** Whether no attempt currently owns the lease (this direction may start a read). */
export function isPaginationFetchLeaseFree(lease: PaginationFetchLease): boolean {
  return lease.owner === null
}

export const createPaginationFetchLease = (): PaginationFetchLease => ({ owner: null })

/** Whether `token` currently owns the lease (the attempt may publish). */
export function ownsPaginationFetchLease(lease: PaginationFetchLease, token: object | null): boolean {
  return token !== null && lease.owner === token
}

/** Claim the lease for `token`. False when another attempt already owns it. */
export function claimPaginationFetchLease(lease: PaginationFetchLease, token: object): boolean {
  if (lease.owner !== null) return false
  lease.owner = token
  return true
}

/**
 * Release the lease. With a `token`, only the owning attempt can release it.
 * Without a `token`, the release is forced. Returns whether the lease is free.
 */
export function releasePaginationFetchLease(lease: PaginationFetchLease, token?: object | null): boolean {
  if (token !== undefined && lease.owner !== token) return lease.owner === null
  lease.owner = null
  return true
}
