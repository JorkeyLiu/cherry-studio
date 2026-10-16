import { dbService } from '@renderer/services/db'
import type { AppDispatch } from '@renderer/store'
import {
  bumpGeneration,
  fingerprintSegmentCatalog,
  publishSegmentCatalogComplete
} from '@renderer/store/residentRegistry'
import { replaceSegmentsForTopic } from '@renderer/store/topicSegment'
import type { TopicSegment } from '@renderer/types/topicSegment'
import type { SegmentWire } from '@shared/chatDb'

/**
 * Map a Main SegmentWire to a renderer TopicSegment (all authority fields).
 * JSON-safety: omit the optional `color` own property unless the wire
 * carries a legal string (never `color: undefined`).
 */
export function mapSegmentWireToTopicSegment(wire: SegmentWire): TopicSegment {
  const segment: TopicSegment = {
    id: wire.id,
    topicId: wire.topicId,
    name: wire.name ?? '',
    messageIds: [...wire.messageIds],
    createdAt: wire.createdAt ?? new Date().toISOString(),
    updatedAt: wire.updatedAt ?? new Date().toISOString(),
    sortOrder: wire.sortOrder,
    firstMessageId: wire.firstMessageId,
    lastMessageId: wire.lastMessageId,
    messageCount: wire.messageCount
  }
  if (typeof wire.color === 'string') {
    segment.color = wire.color
  }
  return segment
}

/**
 * Deterministic per-topic request ordering for overlapping catalog reads.
 * Module-local only (no cache/persistent state machine): the latest issued
 * sequence per topic wins; an older read never overwrites a newer accepted
 * snapshot even with identical IDs/content, and a rejected older request
 * never invalidates the healthy newer result.
 */
const latestIssuedSeqByTopic = new Map<string, number>()
const latestPublishedSeqByTopic = new Map<string, number>()
let catalogRequestSeq = 0

export function resetCatalogRequestSeqForTests(): void {
  latestIssuedSeqByTopic.clear()
  latestPublishedSeqByTopic.clear()
  catalogRequestSeq = 0
}

function activeRouteOf(state: any, topicId: string): string | null {
  try {
    const raw = state?.topicBranch?.activeBranchIdByTopic?.[topicId] ?? null
    return (raw as string | null) ?? null
  } catch {
    return null
  }
}

function routeGenerationOf(state: any, topicId: string): number {
  try {
    const raw = state?.topicBranch?.routeGenerationByTopic?.[topicId]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  } catch {
    return 0
  }
}

function residentWindowOf(
  state: any,
  topicId: string
): {
  resident: boolean
  generation: number
  ids: string[] | null
  route: string | null
  routeGeneration: number
} {
  const entry = state?.residentRegistry?.entries?.[topicId]
  const generation: number = entry?.applicabilityGeneration ?? 0
  const resident: boolean = !!entry?.residentTopic
  const raw = state?.messages?.messageIdsByTopic?.[topicId]
  const ids: string[] | null = resident && Array.isArray(raw) ? [...raw] : null
  return {
    resident,
    generation,
    ids,
    route: activeRouteOf(state, topicId),
    routeGeneration: routeGenerationOf(state, topicId)
  }
}

function currentCatalogOf(state: any, topicId: string): TopicSegment[] {
  try {
    const ids: string[] = state?.topicSegments?.segmentsByTopic?.[topicId] ?? []
    const entities = state?.topicSegments?.segments?.entities ?? {}
    return ids.map((id: string) => entities[id]).filter(Boolean)
  } catch {
    return []
  }
}

function sameIds(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function exactApplicability(
  a: {
    resident: boolean
    generation: number
    ids: string[] | null
    route: string | null
    routeGeneration: number
    fingerprint: string
  },
  b: {
    resident: boolean
    generation: number
    ids: string[] | null
    route: string | null
    routeGeneration: number
    fingerprint: string
  }
): boolean {
  return (
    a.generation === b.generation &&
    a.resident === b.resident &&
    (a.route ?? null) === (b.route ?? null) &&
    a.routeGeneration === b.routeGeneration &&
    sameIds(a.ids, b.ids) &&
    a.fingerprint === b.fingerprint
  )
}

/**
 * Typed catalog-convergence failure: a list read (or projection publication
 * read) failed AFTER Main writes already committed.
 *
 * Carries the committed/read context (topicId + cause) and makes NO message
 * mutation claim — callers must treat this as a projection failure (authority
 * stands, projection invalidated fenced, no fabricated catalog), never as a
 * pre-commit rejection. Stale/superseded reads remain normal discard (no
 * throw). Actual Main segment upsert/replace failures are never wrapped here
 * and must stay fail-closed operation failures.
 */
export class SegmentCatalogConvergenceError extends Error {
  readonly catalogConvergence = true as const
  readonly committed = true as const
  readonly topicId: string

  constructor(message: string, topicId: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SegmentCatalogConvergenceError'
    this.topicId = topicId
  }
}

/** Narrow guard for the catalog-convergence marker (works across mocked module boundaries). */
export function isSegmentCatalogConvergenceError(error: unknown): error is SegmentCatalogConvergenceError {
  if (error instanceof SegmentCatalogConvergenceError) return true
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { catalogConvergence?: unknown; topicId?: unknown }
  return candidate.catalogConvergence === true && typeof candidate.topicId === 'string'
}

/**
 * Renderer-internal catalog convergence: read-after list + ONE explicit
 * authority-backed segment-catalog publication that preserves the resident
 * message projection (PROJ-10/I-5, resident atomic contract).
 *
 * Content-aware applicability + deterministic per-topic ordering:
 * - Captures generation + resident window + route provenance + existing
 *   route-generation token + full authority-field catalog fingerprint before
 *   the list, with a per-topic monotonic request sequence. After the list,
 *   publication requires the captured applicability to still be exact AND
 *   this request to still be the latest issued (an older late read never
 *   overwrites a newer accepted snapshot, even with identical IDs/content;
 *   an away-and-back excursion with an identical route value still discards
 *   via the bumped route-generation token).
 * - Superseded reads discard as normal control flow: no bump (never
 *   invalidate the healthy successor window), no throw — the DB mutation
 *   itself succeeded, only this read is stale. Callers keep their successful
 *   mutation bookkeeping; the successor publication (or a later converge)
 *   carries the fresh catalog.
 * - List/DB failure is distinct from supersession: it fences cleanup to the
 *   exact captured applicability (bumps only when the current window still
 *   owns that exact generation/window/route/route-generation/catalog) then
 *   throws, so a healthy successor is never destroyed while an unknown
 *   catalog never claims healthy. No forced reload, no fabricated
 *   single-wire success.
 * - On stable success dispatches exactly one
 *   `resident/segmentCatalogPublishComplete` (full authority catalog, no
 *   transient resident=false frame, no generation bump). Raw unpaired and
 *   fromSync structural actions keep their centralized invalidation.
 * - All production callers provide getState (required signature); there is
 *   no silent raw path.
 */
export async function convergeTopicSegmentCatalog(
  dispatch: AppDispatch,
  topicId: string,
  getState: () => any
): Promise<TopicSegment[]> {
  if (typeof getState !== 'function') {
    throw new TypeError('[convergeTopicSegmentCatalog] getState is required; raw path removed')
  }
  const beforeWindow = residentWindowOf(getState(), topicId)
  const beforeCatalog = currentCatalogOf(getState(), topicId)
  const beforeFingerprint = fingerprintSegmentCatalog(beforeCatalog)
  const before = { ...beforeWindow, fingerprint: beforeFingerprint }
  const requestSeq = ++catalogRequestSeq
  latestIssuedSeqByTopic.set(topicId, requestSeq)
  let wires: SegmentWire[]
  try {
    wires = await dbService.listSegments(topicId)
  } catch (error) {
    // Fenced fail-closed: bump only when the current window still owns the
    // exact captured applicability (same gen/window/route/route-gen/catalog).
    // A successor (bumped, switched incl. away-and-back, republished) is
    // never invalidated.
    try {
      const curWindow = residentWindowOf(getState(), topicId)
      const curFingerprint = fingerprintSegmentCatalog(currentCatalogOf(getState(), topicId))
      const cur = { ...curWindow, fingerprint: curFingerprint }
      if (cur.resident && exactApplicability(cur, before)) {
        try {
          dispatch(bumpGeneration(topicId))
        } catch {
          // best-effort; never mask the original failure
        }
      }
    } catch {
      // best-effort invalidation; never mask the original failure
    }
    // Typed projection failure AFTER Main writes: authority stands, no
    // fabricated catalog, never mark resident complete. Stale/superseded
    // reads discard silently above (no throw); only a genuine list failure
    // throws, wrapped with the committed/read context.
    const causeMessage = (error as Error)?.message ?? String(error)
    throw new SegmentCatalogConvergenceError(
      `[convergeTopicSegmentCatalog] Segment catalog read failed after Main commit for topic ${topicId}; projection invalidated without fabricated catalog: ${causeMessage}`,
      topicId,
      { cause: error }
    )
  }
  const segments = wires.map(mapSegmentWireToTopicSegment)
  const afterWindow = residentWindowOf(getState(), topicId)
  const afterFingerprint = fingerprintSegmentCatalog(currentCatalogOf(getState(), topicId))
  const after = { ...afterWindow, fingerprint: afterFingerprint }
  // Deterministic ordering: only the latest issued request may publish. A
  // late older read (even with identical IDs/content) discards silently, and
  // an already-published newer snapshot is never regressed.
  const latestIssued = latestIssuedSeqByTopic.get(topicId)
  const latestPublished = latestPublishedSeqByTopic.get(topicId)
  if (latestIssued !== requestSeq || (typeof latestPublished === 'number' && requestSeq < latestPublished)) {
    return currentCatalogOf(getState(), topicId)
  }
  const stable = exactApplicability(after, before)
  if (!stable) {
    // Superseded (concurrent bump/eviction/route switch/window republish or
    // a newer catalog already accepted): discard as normal control flow.
    // No bump — the successor window/catalog is healthy. No throw — the
    // caller's DB mutation succeeded; only this read is stale.
    return currentCatalogOf(getState(), topicId)
  }
  dispatch(
    publishSegmentCatalogComplete({
      topicId,
      generation: after.generation,
      segments,
      messageIds: after.resident ? [...(after.ids as string[])] : null,
      route: after.route,
      baseFingerprint: beforeFingerprint,
      routeGeneration: after.routeGeneration
    })
  )
  latestPublishedSeqByTopic.set(topicId, requestSeq)
  return segments
}

// Legacy compat: some suites mock the raw replace path symbol. Kept exported
// for those mocks only; production code must use convergeTopicSegmentCatalog.
export { replaceSegmentsForTopic }
