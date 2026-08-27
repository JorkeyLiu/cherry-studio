/**
 * Phase 4 resident read-path observability — renderer-local, bounded scalar-only.
 *
 * Purpose: expose cache hit/miss reason, staged read latency, and discarded
 * publication attempt diagnostics for the actual topic message loading lifecycle
 * (`loadTopicMessagesThunk`). Renderer-local, testable, no persistence/IPC/shared
 * schema/SQLite/StoreSync, no policy thresholds, no B-01..B-05 adoption.
 *
 * Semantics (LOCK-005): `discardedCount` counts only attempts discarded after reaching
 * the joint-publication validation path (superseded/currentMoved/deletedDuringFetch/
 * generationMismatch/malformed). A staged fetch failure before validation is recorded
 * only as staged failure/latency (stagedFailedCount/stagedCount), not as discarded.
 *
 * Privacy: bounded scalars only. Must not retain topic IDs, message content,
 * paths, credentials, or unbounded histories/maps. All counters are finite
 * numbers; latency is summarized as bounded scalars (count/total/max/last).
 */

export type ResidentReadMissReason = 'forced' | 'noIndex' | 'deletion' | 'legacyEmpty' | 'noEntry' | 'incomplete'

export type ResidentReadDiscardReason =
  | 'superseded'
  | 'currentMoved'
  | 'deletedDuringFetch'
  | 'generationMismatch'
  | 'malformed'

export interface ResidentReadDiagnostics {
  /** Total cache-hit decisions (early return without staged fetch) */
  hitCount: number
  /** Total cache-miss decisions (proceeded to staged fetch) */
  missCount: number
  /** Derived total requests observed (hit + miss) */
  totalRequests: number
  /** Miss reason breakdown — each is bounded scalar counter */
  missForced: number
  missNoIndex: number
  missDeletion: number
  missLegacyEmpty: number
  missNoEntry: number
  missIncomplete: number
  /** Staged fetch latency summaries — bounded scalars, ms */
  stagedCount: number
  stagedSuccessCount: number
  stagedFailedCount: number
  stagedTotalMs: number
  stagedMaxMs: number
  stagedLastMs: number | null
  stagedAvgMs: number | null
  /** Discarded publication attempts — bounded scalars (post-stage validation only; fetch failure before validation is staged failure, not discarded) */
  discardedCount: number
  discardedSuperseded: number
  discardedCurrentMoved: number
  discardedDeletedDuringFetch: number
  discardedGenerationMismatch: number
  discardedMalformed: number
}

// ---------------------------------------------------------------------------
// Module-local bounded scalar state — renderer-local, no persistence
// ---------------------------------------------------------------------------

let hitCount = 0
let missForced = 0
let missNoIndex = 0
let missDeletion = 0
let missLegacyEmpty = 0
let missNoEntry = 0
let missIncomplete = 0

let stagedCount = 0
let stagedSuccessCount = 0
let stagedFailedCount = 0
let stagedTotalMs = 0
let stagedMaxMs = 0
let stagedLastMs: number | null = null

let discardedSuperseded = 0
let discardedCurrentMoved = 0
let discardedDeletedDuringFetch = 0
let discardedGenerationMismatch = 0
let discardedMalformed = 0

function finiteNonNegative(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0
  return n
}

export function getResidentReadDiagnostics(): ResidentReadDiagnostics {
  const missCount = missForced + missNoIndex + missDeletion + missLegacyEmpty + missNoEntry + missIncomplete
  const totalRequests = hitCount + missCount
  const discardedCount =
    discardedSuperseded +
    discardedCurrentMoved +
    discardedDeletedDuringFetch +
    discardedGenerationMismatch +
    discardedMalformed
  // stagedAvg derived scalar, bounded
  const stagedAvgMs = stagedCount > 0 ? stagedTotalMs / stagedCount : null
  return {
    hitCount: finiteNonNegative(hitCount),
    missCount: finiteNonNegative(missCount),
    totalRequests: finiteNonNegative(totalRequests),
    missForced: finiteNonNegative(missForced),
    missNoIndex: finiteNonNegative(missNoIndex),
    missDeletion: finiteNonNegative(missDeletion),
    missLegacyEmpty: finiteNonNegative(missLegacyEmpty),
    missNoEntry: finiteNonNegative(missNoEntry),
    missIncomplete: finiteNonNegative(missIncomplete),
    stagedCount: finiteNonNegative(stagedCount),
    stagedSuccessCount: finiteNonNegative(stagedSuccessCount),
    stagedFailedCount: finiteNonNegative(stagedFailedCount),
    stagedTotalMs: finiteNonNegative(stagedTotalMs),
    stagedMaxMs: finiteNonNegative(stagedMaxMs),
    stagedLastMs: stagedLastMs !== null ? finiteNonNegative(stagedLastMs) : null,
    stagedAvgMs: stagedAvgMs !== null ? finiteNonNegative(stagedAvgMs) : null,
    discardedCount: finiteNonNegative(discardedCount),
    discardedSuperseded: finiteNonNegative(discardedSuperseded),
    discardedCurrentMoved: finiteNonNegative(discardedCurrentMoved),
    discardedDeletedDuringFetch: finiteNonNegative(discardedDeletedDuringFetch),
    discardedGenerationMismatch: finiteNonNegative(discardedGenerationMismatch),
    discardedMalformed: finiteNonNegative(discardedMalformed)
  }
}

export function resetResidentReadDiagnosticsForTests(): void {
  hitCount = 0
  missForced = 0
  missNoIndex = 0
  missDeletion = 0
  missLegacyEmpty = 0
  missNoEntry = 0
  missIncomplete = 0
  stagedCount = 0
  stagedSuccessCount = 0
  stagedFailedCount = 0
  stagedTotalMs = 0
  stagedMaxMs = 0
  stagedLastMs = null
  discardedSuperseded = 0
  discardedCurrentMoved = 0
  discardedDeletedDuringFetch = 0
  discardedGenerationMismatch = 0
  discardedMalformed = 0
}

export function recordResidentReadHit(): void {
  hitCount += 1
}

export function recordResidentReadMiss(reason: ResidentReadMissReason): void {
  switch (reason) {
    case 'forced':
      missForced += 1
      break
    case 'noIndex':
      missNoIndex += 1
      break
    case 'deletion':
      missDeletion += 1
      break
    case 'legacyEmpty':
      missLegacyEmpty += 1
      break
    case 'noEntry':
      missNoEntry += 1
      break
    case 'incomplete':
      missIncomplete += 1
      break
    default:
      // unknown reason is not counted to keep taxonomy bounded
      break
  }
}

export function recordStagedLatency(durationMs: number, success: boolean): void {
  const d = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0
  stagedCount += 1
  stagedTotalMs += d
  if (d > stagedMaxMs) stagedMaxMs = d
  stagedLastMs = d
  if (success) stagedSuccessCount += 1
  else stagedFailedCount += 1
}

export function recordResidentReadDiscard(reason: ResidentReadDiscardReason): void {
  switch (reason) {
    case 'superseded':
      discardedSuperseded += 1
      break
    case 'currentMoved':
      discardedCurrentMoved += 1
      break
    case 'deletedDuringFetch':
      discardedDeletedDuringFetch += 1
      break
    case 'generationMismatch':
      discardedGenerationMismatch += 1
      break
    case 'malformed':
      discardedMalformed += 1
      break
    default:
      break
  }
}
