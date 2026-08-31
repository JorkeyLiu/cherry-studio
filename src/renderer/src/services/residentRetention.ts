/**
 * Renderer-local resident retention owner — B-01..B-05.
 *
 * Renderer-local only; no IPC/preload/Main/SQLite/schema/StoreSync persistence.
 * Pinned = active, loading, request/stream queue pending/in-flight, window read outstanding.
 * Eviction atomically removes only renderer projections (messages, exclusive blocks,
 * segments, window completeness, context closure, retention ownership + generation fencing)
 * and retains scroll snapshots, never invokes Main deletion, never terminates stream.
 * To fence stale fetch, eviction advances only renderer applicability generation via
 * dedicated retention path (retention/evictTopic), never deletion generation.
 *
 * Retention metadata (lastAccess, logical bytes, diagnostics) is separate from residentRegistry
 * generation/completeness core state.
 */

import { loggerService } from '@logger'
import type { Store } from '@reduxjs/toolkit'
import { clearLatestWindowCompleteness } from '@renderer/pages/home/Messages/messageWindow'
import { clearCachedContextClosure } from '@renderer/services/contextClosure'
import { setRetentionClearHandler } from '@renderer/services/retentionClearHandler'
import { retentionEvict } from '@renderer/store/residentRegistry'
import { getTopicPendingRequestCount, hasTopicPendingRequests } from '@renderer/utils/queue'
import { registerQueueIdleCallback } from '@renderer/utils/queueIdle'
import { getWindowReadQueueDepth } from '@renderer/utils/windowReadQueue'
import { registerWindowReadQueueIdleCallback } from '@renderer/utils/windowReadQueueIdle'
import { canonicalizeLogicalPayload, type LogicalPayloadTopicInput } from '@shared/chatDb/logicalPayload'

import {
  RETENTION_MAX_BYTES,
  RETENTION_MAX_EVICTABLE_TOPICS,
  RETENTION_TTL_MS,
  type RetentionCandidate,
  selectRetentionEvictionOrder
} from './residentRetentionPolicy'

const logger = loggerService.withContext('ResidentRetention')

// ---------------------------------------------------------------------------
// Local retention metadata (separate from residentRegistry)
// ---------------------------------------------------------------------------

const lastAccessByTopic = new Map<string, number>()
const byteCache = new Map<string, { bytes: number; generation: number }>()

interface RetentionCounters {
  ttlSweeps: number
  ttlEvicted: number
  oversizedEvicted: number
  lruCountEvicted: number
  lruByteEvicted: number
  totalEvicted: number
  lastSweepAt: number | null
  lastAggregateBytes: number
  lastEvictableCount: number
  lastPinnedCount: number
}

const counters: RetentionCounters = {
  ttlSweeps: 0,
  ttlEvicted: 0,
  oversizedEvicted: 0,
  lruCountEvicted: 0,
  lruByteEvicted: 0,
  totalEvicted: 0,
  lastSweepAt: null,
  lastAggregateBytes: 0,
  lastEvictableCount: 0,
  lastPinnedCount: 0
}

let ttlTimer: ReturnType<typeof setInterval> | null = null
let storeUnsubscribe: (() => void) | null = null
let boundStore: Store | null = null
const prevPinned = new Map<string, boolean>()
let prevCurrentTopic: string | null = null
let queueIdleUnsubscribe: (() => void) | null = null
let windowReadIdleUnsubscribe: (() => void) | null = null
let prevMessagesForBytes: any = null
let prevBlocksForBytes: any = null
let prevSegmentsForBytes: any = null
let pendingBackgroundTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isTopicPinned(topicId: string, state: any): boolean {
  try {
    if (state?.messages?.currentTopicId === topicId) return true
    if (state?.messages?.loadingByTopic?.[topicId]) return true
    if (hasTopicPendingRequests(topicId)) return true
    if (getWindowReadQueueDepth(topicId) > 0) return true
  } catch {
    // best-effort pinned check
  }
  return false
}

function computeLogicalBytesForTopic(topicId: string, state: any): number {
  try {
    const entry = state?.residentRegistry?.entries?.[topicId]
    if (!entry || !entry.residentTopic) return 0
    const generation = entry.applicabilityGeneration ?? 0
    const cached = byteCache.get(topicId)
    if (cached && cached.generation === generation) return cached.bytes

    const messageIds: string[] = state?.messages?.messageIdsByTopic?.[topicId] ?? []
    const msgEntities = state?.messages?.entities ?? {}
    const messages: Record<string, unknown>[] = []
    for (const id of messageIds) {
      const m = msgEntities[id]
      if (!m) throw new Error(`missing indexed message entity: ${id} for topic ${topicId}`)
      messages.push(m as unknown as Record<string, unknown>)
    }
    // Include also orphan messages? Strictly id list defines payload.
    const blockEntities = state?.messageBlocks?.entities ?? {}
    const blocks: Record<string, unknown>[] = []
    const seenBlockIds = new Set<string>()
    for (const m of messages) {
      const bids = (m as any).blocks as unknown
      if (Array.isArray(bids)) {
        for (const bid of bids as unknown[]) {
          if (typeof bid !== 'string' || seenBlockIds.has(bid)) continue
          const b = blockEntities[bid]
          if (!b)
            throw new Error(
              `missing indexed block entity: ${String(bid)} for message ${String((m as any).id)} topic ${topicId}`
            )
          blocks.push(b as unknown as Record<string, unknown>)
          seenBlockIds.add(bid)
        }
      }
    }
    // Also include orphan blocks whose messageId is in this topic's message set but not referenced via blocks array
    // (partial projection case) — ensure completeness for byte accounting
    const msgIdSet = new Set(messageIds)
    for (const b of Object.values(blockEntities) as Array<Record<string, unknown> | undefined>) {
      if (!b) continue
      const mid = (b as any).messageId
      const bid = (b as any).id
      if (typeof mid === 'string' && msgIdSet.has(mid) && typeof bid === 'string' && !seenBlockIds.has(bid)) {
        blocks.push(b)
        seenBlockIds.add(bid)
      }
    }

    const segEntities = state?.topicSegments?.segments?.entities ?? {}
    const segsByTopic = state?.topicSegments?.segmentsByTopic?.[topicId] ?? []
    const segments: Record<string, unknown>[] = []
    for (const sid of segsByTopic) {
      const s = segEntities[sid]
      if (!s) throw new Error(`missing indexed segment entity: ${sid} for topic ${topicId}`)
      segments.push(s as unknown as Record<string, unknown>)
    }

    const input: LogicalPayloadTopicInput = {
      topicId,
      messages,
      blocks,
      segments,
      completeness: {
        chatData: !!entry.chatData,
        segments: !!entry.segments,
        residentTopic: !!entry.residentTopic
      },
      applicabilityGeneration: generation
    }
    const result = canonicalizeLogicalPayload(input)
    byteCache.set(topicId, { bytes: result.byteLength, generation })
    return result.byteLength
  } catch (e) {
    logger.warn('[residentRetention] logical payload compute failed — fail-closed as oversized', { topicId } as any)
    // Fail-closed immediate correctness: inability to compute bytes must never be treated as zero
    // or allow capacity bounds to be satisfied falsely. Treat as oversized (>32 MiB)
    // so B-02/B-05 enforcement evicts the non-accountable resident.
    const failBytes = RETENTION_MAX_BYTES + 1
    try {
      const entry = state?.residentRegistry?.entries?.[topicId]
      const generation = entry?.applicabilityGeneration ?? 0
      byteCache.set(topicId, { bytes: failBytes, generation })
    } catch {}
    return failBytes
  }
}

function collectCandidates(state: any, now: number): { candidates: RetentionCandidate[]; pinnedCount: number } {
  const entries = state?.residentRegistry?.entries as Record<string, { residentTopic: boolean }> | undefined
  if (!entries) return { candidates: [], pinnedCount: 0 }
  const candidates: RetentionCandidate[] = []
  let pinnedCount = 0
  for (const [topicId, entry] of Object.entries(entries)) {
    if (!entry?.residentTopic) continue
    if (isTopicPinned(topicId, state)) {
      pinnedCount += 1
      continue
    }
    let lastAccess = lastAccessByTopic.get(topicId)
    if (lastAccess === undefined) {
      // No lastAccess yet for an evictable topic — treat as now (no immediate TTL)
      // This covers topics that became evictable but whose unpin wasn't explicitly recorded
      lastAccess = now
      lastAccessByTopic.set(topicId, lastAccess)
    }
    const bytes = computeLogicalBytesForTopic(topicId, state)
    candidates.push({ topicId, lastAccess, byteLength: bytes })
  }
  return { candidates, pinnedCount }
}

// ---------------------------------------------------------------------------
// Public lastAccess ops (renderer-local, not persisted)
// ---------------------------------------------------------------------------

export function getLastAccess(topicId: string): number | undefined {
  return lastAccessByTopic.get(topicId)
}

export function setLastAccess(topicId: string, at: number): void {
  if (typeof topicId !== 'string' || topicId.length === 0) return
  if (typeof at !== 'number' || !Number.isFinite(at)) return
  lastAccessByTopic.set(topicId, at)
}

export function clearRetentionForTopic(topicId: string): void {
  lastAccessByTopic.delete(topicId)
  byteCache.delete(topicId)
}

export function invalidateRetentionByteCache(topicId: string): void {
  if (typeof topicId === 'string' && topicId.length > 0) byteCache.delete(topicId)
}

export function invalidateAllRetentionByteCaches(): void {
  byteCache.clear()
}

export function getRetentionLastAccessMapForTests(): Map<string, number> {
  return new Map(lastAccessByTopic)
}

export function setRetentionLastAccessForTests(topicId: string, at: number): void {
  lastAccessByTopic.set(topicId, at)
}

export function resetRetentionForTests(): void {
  lastAccessByTopic.clear()
  byteCache.clear()
  prevPinned.clear()
  prevCurrentTopic = null
  prevMessagesForBytes = null
  prevBlocksForBytes = null
  prevSegmentsForBytes = null
  counters.ttlSweeps = 0
  counters.ttlEvicted = 0
  counters.oversizedEvicted = 0
  counters.lruCountEvicted = 0
  counters.lruByteEvicted = 0
  counters.totalEvicted = 0
  counters.lastSweepAt = null
  counters.lastAggregateBytes = 0
  counters.lastEvictableCount = 0
  counters.lastPinnedCount = 0
}

export function getResidentRetentionDiagnostics(): RetentionCounters & {
  retentionMapSize: number
  byteCacheSize: number
} {
  return {
    ttlSweeps: counters.ttlSweeps,
    ttlEvicted: counters.ttlEvicted,
    oversizedEvicted: counters.oversizedEvicted,
    lruCountEvicted: counters.lruCountEvicted,
    lruByteEvicted: counters.lruByteEvicted,
    totalEvicted: counters.totalEvicted,
    lastSweepAt: counters.lastSweepAt,
    lastAggregateBytes: counters.lastAggregateBytes,
    lastEvictableCount: counters.lastEvictableCount,
    lastPinnedCount: counters.lastPinnedCount,
    retentionMapSize: lastAccessByTopic.size,
    byteCacheSize: byteCache.size
  }
}

export function resetResidentRetentionDiagnosticsForTests(): void {
  counters.ttlSweeps = 0
  counters.ttlEvicted = 0
  counters.oversizedEvicted = 0
  counters.lruCountEvicted = 0
  counters.lruByteEvicted = 0
  counters.totalEvicted = 0
  counters.lastSweepAt = null
}

// ---------------------------------------------------------------------------
// Unpin handling — record lastAccess then evaluate
// ---------------------------------------------------------------------------

export function maybeRecordUnpin(topicId: string, now = Date.now()): boolean {
  if (typeof topicId !== 'string' || topicId.length === 0) return false
  const state = boundStore?.getState?.()
  if (!state) return false
  if (isTopicPinned(topicId, state)) return false
  const existing = lastAccessByTopic.get(topicId)
  // Only record if not already recorded after becoming unpinned; if already have a recent value,
  // do not overwrite to preserve true unpin time. But if stale (pinned previously), we set now.
  const wasPinned = prevPinned.get(topicId) ?? false
  if (wasPinned || existing === undefined) {
    lastAccessByTopic.set(topicId, now)
    return true
  }
  return false
}

export function onTopicDeactivated(topicId: string, now = Date.now()): void {
  maybeRecordUnpin(topicId, now)
  void enforceRetention(now)
}

export function onTopicsSettled(topicIds: string[], now = Date.now()): void {
  let did = false
  for (const id of topicIds) {
    if (maybeRecordUnpin(id, now)) did = true
  }
  if (did) void enforceRetention(now)
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export function enforceRetention(now = Date.now(), storeOverride?: Store): string[] {
  const store = storeOverride ?? boundStore
  if (!store || typeof store.getState !== 'function') return []
  const state = store.getState()
  const { candidates, pinnedCount } = collectCandidates(state, now)
  const aggregateBytes = candidates.reduce((s, c) => s + c.byteLength, 0)

  counters.ttlSweeps += 1
  counters.lastSweepAt = now
  counters.lastAggregateBytes = aggregateBytes
  counters.lastEvictableCount = candidates.length
  counters.lastPinnedCount = pinnedCount

  if (candidates.length === 0) return []

  const plan = selectRetentionEvictionOrder(candidates, now, {
    maxTopics: RETENTION_MAX_EVICTABLE_TOPICS,
    maxBytes: RETENTION_MAX_BYTES,
    ttlMs: RETENTION_TTL_MS
  })

  if (plan.victims.length === 0) return []

  for (const topicId of plan.victims) {
    const reason = plan.reasonByTopic[topicId]
    try {
      // Dispatch retention-eviction — advances generation via dedicated retention path and atomically
      // clears messages/blocks/segments via Redux; window/closure cleared in rootReducer side effect.
      store.dispatch(retentionEvict(topicId))
      // Belt-and-suspenders for non-Redux window/closure Maps (in case rootReducer path not yet wired)
      try {
        clearLatestWindowCompleteness(topicId)
      } catch {}
      try {
        clearCachedContextClosure(topicId)
      } catch {}
      // Clear retention ownership for that topic
      clearRetentionForTopic(topicId)
      // Diagnostic counters
      counters.totalEvicted += 1
      if (reason === 'ttl') counters.ttlEvicted += 1
      else if (reason === 'oversized') counters.oversizedEvicted += 1
      else if (reason === 'lru-count') counters.lruCountEvicted += 1
      else if (reason === 'lru-bytes') counters.lruByteEvicted += 1
      logger.silly('[residentRetention] evicted topic', { reason } as any)
    } catch (e) {
      logger.warn('[residentRetention] evict failed', e as Error)
    }
  }

  return plan.victims
}

// expose byte helper for tests
export function __test_computeBytes(topicId: string, state: any): number {
  return computeLogicalBytesForTopic(topicId, state)
}

export function __test_getPendingCount(topicId: string): number {
  try {
    return getTopicPendingRequestCount(topicId)
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Timer + subscription lifecycle — bounded, cleaned, no content retained
// ---------------------------------------------------------------------------

function scheduleRetentionBackground(): void {
  try {
    pendingBackgroundTimer = setTimeout(() => {
      pendingBackgroundTimer = null
      // If stopped before task fired, boundStore is null — do not late-register — idempotent post-bootstrap registration
      if (boundStore === null) return
      if (queueIdleUnsubscribe === null) {
        try {
          queueIdleUnsubscribe = registerQueueIdleCallback((topicId: string) => {
            try {
              if (maybeRecordUnpin(topicId, Date.now())) void enforceRetention(Date.now())
              else {
                const st = boundStore?.getState?.()
                if (st && !isTopicPinned(topicId, st)) void enforceRetention(Date.now())
              }
            } catch {}
          })
        } catch (e) {
          try {
            logger.warn('[residentRetention] queueIdle registration failed', e as Error)
          } catch {}
        }
      }
      if (windowReadIdleUnsubscribe === null) {
        try {
          windowReadIdleUnsubscribe = registerWindowReadQueueIdleCallback((topicId: string) => {
            try {
              if (maybeRecordUnpin(topicId, Date.now())) void enforceRetention(Date.now())
              else {
                const st = boundStore?.getState?.()
                if (st && !isTopicPinned(topicId, st)) void enforceRetention(Date.now())
              }
            } catch {}
          })
        } catch (e) {
          try {
            logger.warn('[residentRetention] windowReadIdle registration failed', e as Error)
          } catch {}
        }
      }
      // At-most-60s TTL sweep — exact 60s interval, not retaining content
      if (ttlTimer === null) {
        try {
          ttlTimer = setInterval(() => {
            try {
              void enforceRetention(Date.now())
            } catch {}
          }, 60_000)
          if (ttlTimer && typeof (ttlTimer as any).unref === 'function') {
            ;(ttlTimer as any).unref()
          }
        } catch (e) {
          try {
            logger.warn('[residentRetention] timer registration failed', e as Error)
          } catch {}
        }
      }
    }, 0)
    if (
      pendingBackgroundTimer &&
      typeof (pendingBackgroundTimer as unknown as { unref?: () => void }).unref === 'function'
    ) {
      ;(pendingBackgroundTimer as unknown as { unref: () => void }).unref()
    }
  } catch (e) {
    pendingBackgroundTimer = null
    try {
      logger.warn('[residentRetention] background registration schedule failed', e as Error)
    } catch {}
  }
}

export function startResidentRetention(store: Store): void {
  // Idempotent covering pending 0ms task; retryable on partial failure — idempotent post-bootstrap registration
  if (pendingBackgroundTimer !== null) return
  if (boundStore !== null) {
    const fullyRegistered = ttlTimer !== null && queueIdleUnsubscribe !== null && windowReadIdleUnsubscribe !== null
    if (fullyRegistered) return
    // partial background registration failure — retry without re-doing eager setup
    scheduleRetentionBackground()
    return
  }
  boundStore = store
  const initState = store.getState()
  prevCurrentTopic = initState?.messages?.currentTopicId ?? null
  // seed prevPinned
  const entries = initState?.residentRegistry?.entries ?? {}
  for (const tid of Object.keys(entries)) {
    prevPinned.set(tid, isTopicPinned(tid, initState))
    // seed lastAccess for already evictable topics lacking it
    if (!isTopicPinned(tid, initState) && entries[tid]?.residentTopic && !lastAccessByTopic.has(tid)) {
      lastAccessByTopic.set(tid, Date.now())
    }
  }
  prevMessagesForBytes = initState?.messages ?? null
  prevBlocksForBytes = initState?.messageBlocks ?? null
  prevSegmentsForBytes = initState?.topicSegments ?? null

  // Eager correctness setup: store subscriber + deletion reclamation handler + byte-cache invalidation
  storeUnsubscribe = store.subscribe(() => {
    try {
      const state = store.getState()
      // Invalidate byte cache on ordinary resident message/block/segment projection mutations
      // immediate correctness — no stale byte cache may permit escape from B-02/B-05.
      try {
        const curMsgs = state?.messages ?? null
        const curBlocks = state?.messageBlocks ?? null
        const curSegs = state?.topicSegments ?? null
        const msgsChanged = prevMessagesForBytes !== curMsgs
        const blocksChanged = prevBlocksForBytes !== curBlocks
        const segsChanged = prevSegmentsForBytes !== curSegs
        if (msgsChanged || blocksChanged || segsChanged) {
          // Invalidate all resident byte entries when any projection slice mutated.
          // Conservative and fail-closed; recomputation on next enforce collects fresh bytes.
          const regs = state?.residentRegistry?.entries ?? {}
          for (const tid of Object.keys(regs)) {
            if (regs[tid]?.residentTopic) byteCache.delete(tid)
          }
          // Also handle case where registry entry not yet resident but cache exists from prior residency
          // (hard-delete path already clears, but mutation before eviction still needs invalidation)
          if (msgsChanged || blocksChanged) {
            // If slices changed but no resident entries, still clear any orphan cache to stay fail-closed
            // (no-op if empty)
          }
          prevMessagesForBytes = curMsgs
          prevBlocksForBytes = curBlocks
          prevSegmentsForBytes = curSegs
        }
      } catch {}
      const current = state?.messages?.currentTopicId ?? null
      if (prevCurrentTopic !== null && prevCurrentTopic !== current) {
        // previous active deactivated
        maybeRecordUnpin(prevCurrentTopic, Date.now())
        // immediate enforcement after deactivation
        void enforceRetention(Date.now())
      }
      prevCurrentTopic = current

      // Check pinned->unpinned transitions for any resident topic (covers queue settlement via pinned check)
      const regs = state?.residentRegistry?.entries ?? {}
      for (const tid of Object.keys(regs)) {
        const nowPinned = isTopicPinned(tid, state)
        const wasPinned = prevPinned.get(tid)
        if (wasPinned && !nowPinned) {
          lastAccessByTopic.set(tid, Date.now())
          void enforceRetention(Date.now())
        }
        prevPinned.set(tid, nowPinned)
      }
      // Cleanup prevPinned for removed topics
      for (const tid of Array.from(prevPinned.keys())) {
        if (!(tid in regs)) {
          prevPinned.delete(tid)
          // also clear retention ownership if topic removed elsewhere (deletion)
          lastAccessByTopic.delete(tid)
          byteCache.delete(tid)
        }
      }
    } catch {
      // best-effort, never throw in subscriber
    }
  })

  // Register retention clear handler for hard-delete reclamation without static import cycle — eager
  try {
    setRetentionClearHandler(clearRetentionForTopic)
  } catch (e) {
    try {
      logger.warn('[residentRetention] setRetentionClearHandler failed', e as Error)
    } catch {}
  }

  scheduleRetentionBackground()
}

export function stopResidentRetention(): void {
  if (pendingBackgroundTimer !== null) {
    try {
      clearTimeout(pendingBackgroundTimer)
    } catch {}
    pendingBackgroundTimer = null
  }
  if (ttlTimer !== null) {
    clearInterval(ttlTimer)
    ttlTimer = null
  }
  if (storeUnsubscribe) {
    try {
      storeUnsubscribe()
    } catch {}
    storeUnsubscribe = null
  }
  if (queueIdleUnsubscribe) {
    try {
      queueIdleUnsubscribe()
    } catch {}
    queueIdleUnsubscribe = null
  }
  if (windowReadIdleUnsubscribe) {
    try {
      windowReadIdleUnsubscribe()
    } catch {}
    windowReadIdleUnsubscribe = null
  }
  // Clear retention handler on stop
  try {
    setRetentionClearHandler(null)
  } catch {}
  boundStore = null
  prevPinned.clear()
  prevCurrentTopic = null
  prevMessagesForBytes = null
  prevBlocksForBytes = null
  prevSegmentsForBytes = null
}

export function isRetentionTimerActiveForTests(): boolean {
  return ttlTimer !== null
}

export function isRetentionBackgroundPendingForTests(): boolean {
  return pendingBackgroundTimer !== null
}

export function isRetentionQueueIdleRegisteredForTests(): boolean {
  return queueIdleUnsubscribe !== null
}

export function isRetentionWindowIdleRegisteredForTests(): boolean {
  return windowReadIdleUnsubscribe !== null
}

// Test-only helpers for diagnostics without exposing production non-scalar API.
// Production diagnostics are bounded scalars via getResidentRetentionDiagnostics only — post-bootstrap bounded diagnostics.
export function __test_getLastAccessMap(): Map<string, number> {
  return new Map(lastAccessByTopic)
}

export function __test_getByteCacheMap(): Map<string, { bytes: number; generation: number }> {
  return new Map(byteCache)
}
