/**
 * B-08 ContentSearch local diagnostics — renderer-local, disposable, no persistence.
 *
 * Bounded scalar counters only. No message content, paths, credentials, or sizes retained.
 * Tracks live Range chunk observability: live count (<=500), chunk index/total,
 * DOM generation, invalidation/rescan counters. Preserve release-before-allocation invariant
 * (diagnostics updated only after synchronous release).
 *
 * Ownership: bounded deterministic monotonic protocol.
 * - Per-session numeric IDs allocated monotonically via sessionCounter.
 * - Only bounded scalar state: activeOwnerId and lastCommittedOwnerId (numbers, not Sets).
 * - Commit may take ownership only if caller is active owner or its ID is newer than
 *   lastCommittedOwnerId; stale/older IDs are rejected even when no owner is active.
 * - Clear may only mutate if caller is current active owner; it never claims ownership.
 * - All invalidation/rescan/generation writes are current-active-owner-only.
 * - Release clears live scalars only when caller is active; lastCommittedOwnerId is retained
 *   so stale callbacks are rejected forever without unbounded history.
 */

export interface ContentSearchDiagnostics {
  /** Bounded live Range handles in current chunk (<=500) */
  liveRangeCount: number
  /** Current chunk index (0-based) */
  chunkIndex: number
  /** Total lightweight match count (scalar, not unbounded descriptors) */
  totalCount: number
  /** Total number of rendered-DOM generations observed */
  domGeneration: number
  /** Times session invalidated (target change + DOM dirty) */
  invalidationCount: number
  /** Times chunk rescanned (cross-chunk or stale same-chunk) */
  rescanCount: number
  /** Calibration chunk size constant */
  chunkSize: number
  /** Calibration max live ranges */
  maxLiveRanges: number
}

let liveRangeCount = 0
let chunkIndex = 0
let totalCount = 0
let domGeneration = 0
let invalidationCount = 0
let rescanCount = 0

// B-08 session ownership: bounded monotonic protocol — only scalars, no Set growth.
let activeOwnerId: number | null = null
let lastCommittedOwnerId: number | null = null
let sessionCounter = 0

export function getContentSearchDiagnostics(): ContentSearchDiagnostics {
  return {
    liveRangeCount,
    chunkIndex,
    totalCount,
    domGeneration,
    invalidationCount,
    rescanCount,
    chunkSize: 500,
    maxLiveRanges: 500
  }
}

export function resetContentSearchDiagnosticsForTests(): void {
  liveRangeCount = 0
  chunkIndex = 0
  totalCount = 0
  domGeneration = 0
  invalidationCount = 0
  rescanCount = 0
  activeOwnerId = null
  lastCommittedOwnerId = null
  sessionCounter = 0
}

export function createContentSearchSessionOwnerId(): number {
  sessionCounter += 1
  return sessionCounter
}

export function bindContentSearchSession(_ownerId: number): void {
  // Deprecated: ownership is established only as part of a committed snapshot (commit/clear).
  // Kept as no-op to prevent a merely mounted, unused instance from becoming active and
  // to satisfy the release-before-allocation invariant. No DOM/Range/content retained.
}

export function releaseContentSearchSessionIfOwned(ownerId: number): boolean {
  if (activeOwnerId !== ownerId) return false
  // Retire only if unmounting instance owns the active snapshot: clear live snapshot scalars.
  // Counters (invalidationCount/rescanCount/domGeneration) are preserved as cumulative session metrics,
  // but live handles are zeroed to avoid stale active diagnostics.
  liveRangeCount = 0
  chunkIndex = 0
  totalCount = 0
  activeOwnerId = null
  // lastCommittedOwnerId is deliberately retained so stale callbacks referencing older IDs
  // remain rejected even when no owner is active (bounded, no Set).
  return true
}

export function getActiveContentSearchOwnerForTests(): number | null {
  return activeOwnerId
}

function canCommit(ownerId: number): boolean {
  if (activeOwnerId === ownerId) return true
  if (lastCommittedOwnerId !== null && ownerId <= lastCommittedOwnerId) return false
  // Owner is newer than any prior committed owner (or first ever) => claim
  activeOwnerId = ownerId
  lastCommittedOwnerId = ownerId
  return true
}

function isActiveOwner(ownerId: number): boolean {
  return activeOwnerId === ownerId
}

export function recordContentSearchCommit(
  ownerId: number,
  rangesLength: number,
  nextChunkIndex: number,
  nextTotal: number,
  nextDomGen: number
): void {
  if (!canCommit(ownerId)) return
  liveRangeCount = rangesLength
  chunkIndex = nextChunkIndex
  totalCount = nextTotal
  if (nextDomGen > domGeneration) domGeneration = nextDomGen
}

export function recordContentSearchClear(ownerId: number, nextDomGen: number): void {
  // Clear is active-owner-only and never claims ownership (prevents never-committed steal)
  if (!isActiveOwner(ownerId)) return
  liveRangeCount = 0
  chunkIndex = 0
  totalCount = 0
  if (nextDomGen > domGeneration) domGeneration = nextDomGen
}

export function recordContentSearchInvalidation(ownerId: number, nextDomGen: number): void {
  if (!isActiveOwner(ownerId)) return
  invalidationCount += 1
  if (nextDomGen > domGeneration) domGeneration = nextDomGen
}

export function recordContentSearchRescan(
  ownerId: number,
  rangesLength: number,
  nextChunkIndex: number,
  nextTotal: number,
  nextDomGen: number
): void {
  if (!isActiveOwner(ownerId)) return
  rescanCount += 1
  liveRangeCount = rangesLength
  chunkIndex = nextChunkIndex
  totalCount = nextTotal
  if (nextDomGen > domGeneration) domGeneration = nextDomGen
}

export function recordContentSearchSameChunkRescan(ownerId: number, nextDomGen: number): void {
  if (!isActiveOwner(ownerId)) return
  rescanCount += 1
  if (nextDomGen > domGeneration) domGeneration = nextDomGen
}

export function incrementRescanCount(ownerId: number): void {
  if (!isActiveOwner(ownerId)) return
  rescanCount += 1
}

export function incrementInvalidationCount(ownerId: number): void {
  if (!isActiveOwner(ownerId)) return
  invalidationCount += 1
}

export function syncContentSearchDiagnosticsFromState(
  ownerId: number,
  params: {
    liveRangeCount: number
    chunkIndex: number
    totalCount: number
    domGeneration: number
  }
): void {
  if (!canCommit(ownerId)) return
  liveRangeCount = params.liveRangeCount
  chunkIndex = params.chunkIndex
  totalCount = params.totalCount
  if (params.domGeneration > domGeneration) domGeneration = params.domGeneration
}

export function setContentSearchDomGeneration(ownerId: number, gen: number): void {
  if (!isActiveOwner(ownerId)) return
  if (gen > domGeneration) domGeneration = gen
}

export function recordContentSearchRescanIncrement(ownerId: number): void {
  if (!isActiveOwner(ownerId)) return
  rescanCount += 1
}
