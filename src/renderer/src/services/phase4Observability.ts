/**
 * Phase 4 local observability snapshot — renderer-local, diagnostics only.
 *
 * Purpose: coherent, locally inspectable exercised-workload surface for the four
 * implemented renderer-local Phase 4 mechanisms B-06/B-07/B-08/B-09 plus
 * renderer-local resident lifecycle-foundation diagnostics (bounded scalars).
 *
 * Scope: local-only diagnostics plus tests. No network export, no IPC/preload/shared
 * schema, no StoreSync, no SQLite, no runtime policy semantics, no persistence changes,
 * no user-visible UI behavior. No B-01 through B-05 adoption. Resident diagnostics are
 * read-only, pure, and do not alter lifecycle dispatch, completeness, generation,
 * cache, or ownership behavior.
 *
 * Privacy: snapshot contains only bounded, non-sensitive scalar diagnostics. It must
 * not retain or surface message content, paths, credentials, or database sizes, or
 * unbounded per-topic collections. Resident snapshot is scalar counts/generation only.
 *
 * B-06: bounded viewport observability is per-MessageWindow via pure adapter (no hidden global retention).
 * B-07: scroll snapshot index count + last enforcement outcomes (TTL/LRU) via renderer-local Keyv index.
 * B-08: live Range chunk observability via disposable search session diagnostics.
 * B-09: context-closure active-topic retention + hit/miss counters (resettable test-safe).
 * Resident: bounded scalar counts of resident entries and completeness/generation state (entry/resident/chatData/segments/incomplete/maxGeneration) via pure adapter.
 *
 * This surface is test-facing; prefer exported pure snapshot/read APIs (house pattern).
 */

import {
  type ContentSearchDiagnostics,
  getContentSearchDiagnostics
} from '@renderer/components/contentSearchDiagnostics'
import type { MessageWindow } from '@renderer/pages/home/Messages/messageWindow'
import { MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT } from '@renderer/pages/home/Messages/messageWindow'
import type { ResidentEntry } from '@renderer/store/residentRegistry'

import { type ContextClosureDiagnostics, getContextClosureDiagnostics } from './contextClosure'
import {
  getResidentDiagnostics,
  getResidentDiagnosticsFromGlobalStore,
  type ResidentDiagnostics
} from './residentDiagnostics'
import { getScrollSnapshotDiagnostics, type ScrollSnapshotDiagnostics } from './scrollSnapshotCache'

// ---------------------------------------------------------------------------
// B-06 pure adapter (no hidden global retention)
// ---------------------------------------------------------------------------

export interface Phase4B06Diagnostics {
  /** Calibration default capacity (B-06, 200) */
  calibrationDefault: number
  /** Effective bounded capacity applied */
  boundedCapacity: number
  /** Group count in current window (bounded <=200) */
  groupCount: number
  /** Group capacity (bounded) */
  groupCapacity: number
  /** Whether last construction/expansion trimmed opposite edge */
  didTrim: boolean
  /** Number of groups trimmed from opposite edge */
  trimmedGroups: number
  /** Edge that was trimmed */
  trimmedEdge: 'older' | 'newer' | null
  /** Has more older derived/authoritative flag (scalar, not content) */
  hasMoreOlder: boolean
  /** Has more newer derived/authoritative flag */
  hasMoreNewer: boolean
}

/**
 * Pure adapter for B-06 viewport observability.
 * No hidden global retention — caller supplies the window under test.
 * Returns null when window is null.
 */
export function getB06Diagnostics(window: MessageWindow | null | undefined): Phase4B06Diagnostics | null {
  if (!window) return null
  const obs = window.boundedViewportObservability
  return {
    calibrationDefault: obs?.calibrationDefault ?? MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
    boundedCapacity: obs?.boundedCapacity ?? window.groupCapacity,
    groupCount: window.groupCount,
    groupCapacity: window.groupCapacity,
    didTrim: obs?.didTrim ?? false,
    trimmedGroups: obs?.trimmedGroups ?? 0,
    trimmedEdge: obs?.trimmedEdge ?? null,
    hasMoreOlder: window.hasMoreOlder,
    hasMoreNewer: window.hasMoreNewer
  }
}

// ---------------------------------------------------------------------------
// Resident lifecycle-foundation diagnostics (renderer-local, read-only scalars)
// ---------------------------------------------------------------------------

export type { ResidentDiagnostics } from './residentDiagnostics'
export { getResidentDiagnostics, getResidentDiagnosticsFromState } from './residentDiagnostics'

// ---------------------------------------------------------------------------
// Coherent snapshot
// ---------------------------------------------------------------------------

export interface Phase4Snapshot {
  /** B-06 viewport diagnostics (pure adapter, null if no window supplied) */
  b06: Phase4B06Diagnostics | null
  /** B-07 scroll snapshot diagnostics */
  b07: ScrollSnapshotDiagnostics
  /** B-08 ContentSearch diagnostics */
  b08: ContentSearchDiagnostics
  /** B-09 context-closure diagnostics */
  b09: ContextClosureDiagnostics
  /** Resident lifecycle-foundation diagnostics (bounded scalars, read-only) */
  resident: ResidentDiagnostics
}

/**
 * Returns coherent Phase 4 diagnostics snapshot for B-06..B-09 plus resident lifecycle.
 * Local-only, bounded scalars, no message content. Resident diagnostics are
 * renderer-local read-only scalars derived from the resident registry.
 *
 * @param b06Window optional MessageWindow to observe for B-06; caller owns lifecycle
 * @param residentEntries optional override for resident entries; when omitted reads from global window.store if available
 */
export function getPhase4Snapshot(
  b06Window?: MessageWindow | null,
  residentEntries?: Record<string, ResidentEntry> | null
): Phase4Snapshot {
  const resident =
    residentEntries !== undefined
      ? getResidentDiagnostics(residentEntries ?? null)
      : getResidentDiagnosticsFromGlobalStore()
  return {
    b06: getB06Diagnostics(b06Window ?? null),
    b07: getScrollSnapshotDiagnostics(),
    b08: getContentSearchDiagnostics(),
    b09: getContextClosureDiagnostics(),
    resident
  }
}

/**
 * Convenience: returns common assertion-friendly scalars for exercised-workload tests.
 * All values are bounded scalars suitable for bound checks.
 */
export function getPhase4BoundScalars(
  b06Window?: MessageWindow | null,
  residentEntries?: Record<string, ResidentEntry> | null
): {
  b06GroupCount: number | null
  b06DidTrim: boolean | null
  b06TrimmedEdge: string | null
  b07IndexCount: number
  b07MaxCount: number
  b08LiveRangeCount: number
  b08MaxLive: number
  b08Invalidations: number
  b08Rescans: number
  b09Retained: number
  b09MaxRetained: number
  b09Hits: number
  b09Misses: number
  residentEntryCount: number
  residentResidentCount: number
  residentIncompleteCount: number
  residentChatDataCount: number
  residentSegmentsCount: number
  residentMaxGeneration: number
} {
  const snap = getPhase4Snapshot(b06Window, residentEntries !== undefined ? residentEntries : undefined)
  return {
    b06GroupCount: snap.b06 ? snap.b06.groupCount : null,
    b06DidTrim: snap.b06 ? snap.b06.didTrim : null,
    b06TrimmedEdge: snap.b06 ? snap.b06.trimmedEdge : null,
    b07IndexCount: snap.b07.indexCount,
    b07MaxCount: snap.b07.maxCount,
    b08LiveRangeCount: snap.b08.liveRangeCount,
    b08MaxLive: snap.b08.maxLiveRanges,
    b08Invalidations: snap.b08.invalidationCount,
    b08Rescans: snap.b08.rescanCount,
    b09Retained: snap.b09.retainedTopicCount,
    b09MaxRetained: snap.b09.maxRetainedTopics,
    b09Hits: snap.b09.hitCount,
    b09Misses: snap.b09.missCount,
    residentEntryCount: snap.resident.entryCount,
    residentResidentCount: snap.resident.residentCount,
    residentIncompleteCount: snap.resident.incompleteCount,
    residentChatDataCount: snap.resident.chatDataCount,
    residentSegmentsCount: snap.resident.segmentsCount,
    residentMaxGeneration: snap.resident.maxGeneration
  }
}
