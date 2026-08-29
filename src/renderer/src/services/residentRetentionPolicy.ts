/**
 * Renderer-local B-01..B-05 retention policy — pure, deterministic, side-effect-free.
 *
 * Order is TTL (>=30 minutes idle) then oversized (>32 MiB once unpinned)
 * then count/byte pressure LRU; max 8 inactive evictable topics, aggregate logical
 * payload <=32 MiB, lexical topicId tie-break for equal recency, exactly 32 MiB
 * does not evict. Policy operates over complete resident topics that are evictable
 * (inactive, non-pinned). Pinned determination is outside this pure module.
 *
 * This module has no IPC, persistence, or lifecycle effects — pure ordering only.
 */

import { B01_MAX_TOPICS, B02_MAX_BYTES } from '@shared/chatDb/logicalPayload'

export const RETENTION_TTL_MS = 30 * 60 * 1000
export const RETENTION_MAX_EVICTABLE_TOPICS = B01_MAX_TOPICS
export const RETENTION_MAX_BYTES = B02_MAX_BYTES
export const RETENTION_OVERSIZED_BYTES = B02_MAX_BYTES

export interface RetentionCandidate {
  topicId: string
  lastAccess: number
  byteLength: number
}

export interface RetentionEvictionPlan {
  /** Ordered eviction sequence: TTL first, then oversized, then LRU pressure */
  victims: string[]
  /** Reason per victim */
  reasonByTopic: Record<string, 'ttl' | 'oversized' | 'lru-count' | 'lru-bytes'>
}

function compareTopicId(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function compareLru(a: RetentionCandidate, b: RetentionCandidate): number {
  if (a.lastAccess !== b.lastAccess) return a.lastAccess - b.lastAccess
  return compareTopicId(a.topicId, b.topicId)
}

/**
 * Pure deterministic eviction ordering for B-01..B-05.
 *
 * Candidates must already be the evictable set (inactive, non-pinned, residentTopic true)
 * with definitive lastAccess and byteLength.
 *
 * Steps deterministically:
 * 1. TTL expired (>= TTL) — evicted first, sorted LRU + lexical
 * 2. Oversized (>32 MiB) — evicted second, sorted LRU + lexical
 * 3. Count/byte pressure LRU — evict while count >8 or bytes >32 MiB, oldest first
 *
 * Exactly 32 MiB is NOT oversized and does NOT trigger byte pressure when aggregate == 32 MiB.
 */
export function selectRetentionEvictionOrder(
  candidates: RetentionCandidate[],
  now: number,
  opts?: { maxTopics?: number; maxBytes?: number; ttlMs?: number }
): RetentionEvictionPlan {
  const maxTopics = opts?.maxTopics ?? RETENTION_MAX_EVICTABLE_TOPICS
  const maxBytes = opts?.maxBytes ?? RETENTION_MAX_BYTES
  const ttlMs = opts?.ttlMs ?? RETENTION_TTL_MS

  if (!Array.isArray(candidates)) throw new Error('candidates must be array')
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new Error('now must be finite number')

  // Defensive copy and validation; invalid entries are not candidates (filtered by caller)
  const sortedByLru = [...candidates].sort(compareLru)

  const victims: string[] = []
  const reasonByTopic: Record<string, 'ttl' | 'oversized' | 'lru-count' | 'lru-bytes'> = {}

  const ttlVictims: RetentionCandidate[] = []
  const remainingAfterTtlTot: RetentionCandidate[] = []
  for (const c of sortedByLru) {
    const idle = now - c.lastAccess
    if (idle >= ttlMs) {
      ttlVictims.push(c)
    } else {
      remainingAfterTtlTot.push(c)
    }
  }
  // TTL victims are already LRU sorted
  for (const v of ttlVictims) {
    victims.push(v.topicId)
    reasonByTopic[v.topicId] = 'ttl'
  }

  const oversizedVictims: RetentionCandidate[] = []
  const remainingAfterOversized: RetentionCandidate[] = []
  for (const c of remainingAfterTtlTot) {
    if (c.byteLength > RETENTION_OVERSIZED_BYTES) {
      oversizedVictims.push(c)
    } else {
      remainingAfterOversized.push(c)
    }
  }
  // Oversized sorted LRU
  oversizedVictims.sort(compareLru)
  for (const v of oversizedVictims) {
    victims.push(v.topicId)
    reasonByTopic[v.topicId] = 'oversized'
  }

  // Count/byte pressure over remaining (TTL and oversized already removed)
  const remaining = [...remainingAfterOversized].sort(compareLru)
  let aggregateBytes = remaining.reduce((s, c) => s + c.byteLength, 0)

  while (remaining.length > maxTopics || aggregateBytes > maxBytes) {
    const oldest = remaining.shift()
    if (!oldest) break
    // Distinguish count vs byte pressure for diagnostics, but ordering is still LRU
    const willBeCountPressure = remaining.length + 1 > maxTopics
    // Before removal, check which bound is violated to label reason; if both, prefer count-first when count violated
    // Byte pressure label when aggregate > maxBytes and count not violated alone
    let reason: 'lru-count' | 'lru-bytes' = 'lru-count'
    if (aggregateBytes > maxBytes && remaining.length + 1 <= maxTopics) {
      reason = 'lru-bytes'
    } else if (aggregateBytes > maxBytes && willBeCountPressure) {
      // both violated — deterministic: count-first label when both (matches binding semantics)
      reason = 'lru-count'
    } else if (!willBeCountPressure && aggregateBytes > maxBytes) {
      reason = 'lru-bytes'
    }
    victims.push(oldest.topicId)
    reasonByTopic[oldest.topicId] = reason
    aggregateBytes -= oldest.byteLength
  }

  return { victims, reasonByTopic }
}

/**
 * Totally ordered deterministic eviction sequence for diagnostics/testing.
 * Returns victims in exact policy order with reasons.
 */
export function getSortedCandidatesForDiagnostics(candidates: RetentionCandidate[]): RetentionCandidate[] {
  return [...candidates].sort(compareLru)
}
