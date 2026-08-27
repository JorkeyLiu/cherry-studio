/**
 * Phase 4 lifecycle-foundation resident diagnostics — renderer-local, read-only.
 *
 * Bounded, scalar-only snapshot of the residentRegistry lifecycle foundation.
 * No message content, no paths, no credentials, no unbounded per-topic collections.
 * Pure adapter: counts completeness markers and generation state directly from
 * the existing `Record<string, ResidentEntry>` registry shape.
 *
 * Completeness model: `residentTopic = chatData && segments` for the same
 * `applicabilityGeneration`. Diagnostics reflect that joint completeness, not policy.
 * No B-01..B-05 retention/eviction/TTL/LRU/pin/capacity logic is introduced.
 */

import type { ResidentEntry } from '@renderer/store/residentRegistry'

export interface ResidentDiagnostics {
  /** Total resident registry entries (topics with lifecycle state) */
  entryCount: number
  /** Joint completeness count: residentTopic === true (chatData && segments) */
  residentCount: number
  /** Component marker count: chatData === true */
  chatDataCount: number
  /** Component marker count: segments === true */
  segmentsCount: number
  /** Incomplete count: entryCount - residentCount */
  incompleteCount: number
  /** Maximum applicabilityGeneration across entries (0 when empty) */
  maxGeneration: number
}

/**
 * Pure, bounded, read-only adapter for resident registry diagnostics.
 * No retention of payload objects, paths, or per-topic collections — scalars only.
 */
export function getResidentDiagnostics(entries: Record<string, ResidentEntry> | null | undefined): ResidentDiagnostics {
  if (!entries || typeof entries !== 'object') {
    return {
      entryCount: 0,
      residentCount: 0,
      chatDataCount: 0,
      segmentsCount: 0,
      incompleteCount: 0,
      maxGeneration: 0
    }
  }
  const values = Object.values(entries)
  let residentCount = 0
  let chatDataCount = 0
  let segmentsCount = 0
  let maxGeneration = 0
  for (const e of values) {
    if (!e || typeof e !== 'object') continue
    if (e.residentTopic) residentCount += 1
    if (e.chatData) chatDataCount += 1
    if (e.segments) segmentsCount += 1
    const gen = e.applicabilityGeneration
    if (typeof gen === 'number' && Number.isFinite(gen) && gen > maxGeneration) {
      maxGeneration = gen
    }
  }
  const entryCount = values.length
  // Guard: entryCount is bounded by Object.values length; incomplete is derived scalar
  const incompleteCount = entryCount - residentCount
  return {
    entryCount,
    residentCount,
    chatDataCount,
    segmentsCount,
    incompleteCount: incompleteCount < 0 ? 0 : incompleteCount,
    maxGeneration
  }
}

/**
 * Convenience: extracts resident diagnostics from a Redux state shape.
 * Reads `state.residentRegistry.entries` safely; returns empty diagnostics when absent.
 */
export function getResidentDiagnosticsFromState(state: unknown): ResidentDiagnostics {
  const entries = (state as any)?.residentRegistry?.entries as Record<string, ResidentEntry> | undefined
  return getResidentDiagnostics(entries)
}

/**
 * Reads resident diagnostics from the global window.store when available (renderer-local).
 * Fallback to empty diagnostics when no store or no entries — never throws.
 */
export function getResidentDiagnosticsFromGlobalStore(): ResidentDiagnostics {
  try {
    const w = typeof window !== 'undefined' ? (window as any) : undefined
    const store = w?.store
    if (store && typeof store.getState === 'function') {
      return getResidentDiagnosticsFromState(store.getState())
    }
  } catch {
    // best-effort fallback
  }
  return getResidentDiagnostics(null)
}
