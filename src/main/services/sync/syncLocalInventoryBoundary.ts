/**
 * Bounded main-only local inventory boundary for sync receiver paths.
 *
 * Mirrors the sender capture boundary in `syncBaseline.ts`: topic-internal
 * branch rows are local-only and never enter the sync inventory, while the
 * wire stays unchanged.
 * - Topics are always syncable (logical identity, never branch-owned).
 * - A message is syncable unless it is proven branch-owned: `branch_id` is a
 *   non-empty string. Null, empty, missing (pre-016 rows without the column),
 *   or malformed ownership is treated as main-route (syncable); existing
 *   fail-closed validation elsewhere still applies, so genuine main-domain
 *   unversioned collisions are never masked.
 * - A block carries no branch column; its owner is its parent message's
 *   owner. A block whose parent message is unknown locally is treated as
 *   main-route so existing orphan fail-closed still triggers.
 *
 * Pure predicates only: callers own errors, writes, and rollback. No
 * transport, wire, document, or protocol-version change.
 */

export function isProvenBranchMessageRow(row: { branchId?: unknown } | null | undefined): boolean {
  if (!row || typeof row !== 'object') return false
  const branchId = (row as { branchId?: unknown }).branchId
  return typeof branchId === 'string' && branchId.length > 0
}

export function buildMessageBranchById(rows: Array<{ id: string; branchId?: unknown }>): Map<string, boolean> {
  const byId = new Map<string, boolean>()
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') continue
    byId.set(row.id, isProvenBranchMessageRow(row))
  }
  return byId
}

export function isBranchOwnedBlock(messageId: unknown, messageBranchById: Map<string, boolean>): boolean {
  if (typeof messageId !== 'string') return false
  return messageBranchById.get(messageId) ?? false
}
