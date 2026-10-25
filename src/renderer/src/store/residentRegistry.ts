import { createAction, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { TopicSegment } from '@renderer/types/topicSegment'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'

export interface ResidentEntry {
  chatData: boolean
  segments: boolean
  residentTopic: boolean
  applicabilityGeneration: number
}

export interface ResidentRegistryState {
  entries: Record<string, ResidentEntry>
}

const initialState: ResidentRegistryState = {
  entries: {}
}

export interface JointPublishPayload {
  topicId: string
  generation: number
  windowResponse: FetchMessagesWindowResponse
  segments: TopicSegment[]
  /**
   * Requested route key for the published window (null = main). Optional for
   * backward compatibility; absent clears capability fail-closed.
   */
  route?: string | null
}

export const JOINT_PUBLISH_COMPLETE = 'resident/jointPublishComplete'

export const publishResidentComplete = createAction<JointPublishPayload>(JOINT_PUBLISH_COMPLETE)

/**
 * Authority-backed local segment-catalog publication (segment-only).
 *
 * ONE explicit path that can preserve an unchanged resident message
 * projection after a segment-only mutation (create/dissolve/membership and
 * shared restore/copy/cut convergence). Carries the complete Main catalog
 * (PROJ-10/I-5) plus applicability-generation and resident-window provenance.
 * Route-neutral catalog vs route-local window: the catalog list is neutral;
 * `messageIds` protects the current loaded window (null = no resident window
 * to protect, never re-residents). Raw unpaired/fromSync structural actions
 * keep invalidating; never spoof isJointFollowUp/isDeletePairedFollowUp here.
 */
export const SEGMENT_CATALOG_PUBLISH_COMPLETE = 'resident/segmentCatalogPublishComplete'

export interface SegmentCatalogPublishPayload {
  topicId: string
  generation: number
  segments: TopicSegment[]
  /** Current resident window at publish time; null when nonresident. */
  messageIds: readonly string[] | null
  /**
   * Content-aware applicability token (small typed token, no new cache).
   * - `route`: addressed route provenance at capture (null = main). When
   *   present the root guard requires the current active route to match.
   * - `baseFingerprint`: authority-field fingerprint of the catalog at capture.
   *   When present the root guard requires the current catalog to still equal
   *   the captured base (prevents an older list overwriting a newer accepted
   *   snapshot even with identical IDs).
   * Absent fields retain the legacy gen+window check (backward compat).
   */
  route?: string | null
  baseFingerprint?: string
  /**
   * Existing route-generation token (`topicBranch/routeGenerationByTopic`).
   * When present the root guard requires the current token to still equal
   * the captured token, so an away-and-back excursion (identical route value
   * but bumped generation) discards without touching the successor window.
   * Absent retains the legacy gen+window/route/catalog check.
   */
  routeGeneration?: number
}

export const publishSegmentCatalogComplete = createAction<SegmentCatalogPublishPayload>(
  SEGMENT_CATALOG_PUBLISH_COMPLETE
)

/**
 * Authority-field fingerprint for a segment catalog (order-sensitive).
 * Covers every authority field compared by the root identical-receive guard
 * (id/topicId/name/color/sortOrder/first/last/count/membership), never
 * names-only. Empty readbacks are filtered like the slice (no phantoms).
 */
export const fingerprintSegmentCatalog = (segments: unknown): string => {
  try {
    if (!Array.isArray(segments)) return ''
    const isEmpty = (s: any) =>
      !s ||
      s.messageCount === 0 ||
      !Array.isArray(s.messageIds) ||
      s.messageIds.length === 0 ||
      s.firstMessageId === null ||
      s.lastMessageId === null
    const ordered = [...segments]
      .filter((s) => !isEmpty(s))
      .sort((x: any, y: any) => {
        const ax = typeof x?.sortOrder === 'number' && Number.isFinite(x.sortOrder) ? x.sortOrder : Infinity
        const bx = typeof y?.sortOrder === 'number' && Number.isFinite(y.sortOrder) ? y.sortOrder : Infinity
        if (ax !== bx) return ax - bx
        const ai = typeof x?.id === 'string' ? x.id : ''
        const bi = typeof y?.id === 'string' ? y.id : ''
        return ai < bi ? -1 : ai > bi ? 1 : 0
      })
    return ordered
      .map((s: any) => {
        const ids = Array.isArray(s.messageIds) ? s.messageIds.join(',') : ''
        return [
          s.id,
          s.topicId,
          s.name,
          s.color ?? '',
          s.sortOrder,
          s.firstMessageId,
          s.lastMessageId,
          s.messageCount,
          ids,
          s.createdAt ?? '',
          s.updatedAt ?? ''
        ].join('|')
      })
      .join(';')
  } catch {
    return ''
  }
}

/**
 * Guard for the segment-catalog publication. True = discard (fail closed,
 * never install stale catalog, never restore residency from stale data).
 * - malformed payload -> discard
 * - generation mismatch (bumped/evicted) -> discard
 * - resident: requires payload window to exactly equal the current loaded
 *   window; null payload window or missing/unequal current window -> discard
 * - nonresident: requires payload window null (never re-resident); a
 *   non-null payload window for a nonresident topic -> discard
 * - route provenance (when present): current active route must equal the
 *   captured route (a route switch discards, never invalidates the successor)
 * - route generation (when present, existing `routeGenerationByTopic` token):
 *   current token must equal the captured token, so an away-and-back with an
 *   identical route value still discards without touching the successor
 * - catalog identity (when present): current catalog fingerprint must still
 *   equal the captured base (a newer accepted catalog discards the older
 *   list even with identical IDs/content)
 */
export const shouldDiscardSegmentCatalogPublish = (state: unknown, payload: unknown): boolean => {
  const p = payload as Partial<SegmentCatalogPublishPayload> | undefined
  const topicId = p?.topicId
  const generation = p?.generation
  const segments = p?.segments
  const messageIds = p?.messageIds
  if (typeof topicId !== 'string' || topicId.length === 0) return true
  if (typeof generation !== 'number' || !Number.isFinite(generation)) return true
  if (!Array.isArray(segments)) return true
  const entry = (state as any)?.residentRegistry?.entries?.[topicId]
  const currentGen: number = entry?.applicabilityGeneration ?? 0
  if (currentGen !== generation) return true
  // Route provenance: a switch away (including away-and-back with a live
  // generation change handled above) discards the older publication without
  // touching the successor window.
  if (typeof p?.route !== 'undefined') {
    try {
      const curRoute = (state as any)?.topicBranch?.activeBranchIdByTopic?.[topicId] ?? null
      const want = p?.route ?? null
      const cur = (curRoute as string | null) ?? null
      if (cur !== want) return true
    } catch {
      return true
    }
  }
  // Route generation (existing token, no new state machine): an
  // away-and-back excursion bumps the token twice while the route value
  // returns identical, so the older publication still discards.
  if (typeof p?.routeGeneration === 'number') {
    try {
      const raw = (state as any)?.topicBranch?.routeGenerationByTopic?.[topicId]
      const curGen = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
      if (curGen !== p?.routeGeneration) return true
    } catch {
      return true
    }
  }
  // Catalog identity: the current catalog must still equal the captured base.
  // A newer accepted snapshot (even with identical IDs) discards the older
  // list instead of regressing it.
  if (typeof p?.baseFingerprint === 'string') {
    try {
      const ids: string[] = (state as any)?.topicSegments?.segmentsByTopic?.[topicId] ?? []
      const entities = (state as any)?.topicSegments?.segments?.entities ?? {}
      const current = ids.map((id: string) => entities[id]).filter(Boolean)
      if (fingerprintSegmentCatalog(current) !== p.baseFingerprint) return true
    } catch {
      return true
    }
  }
  const currentResident: boolean = !!entry?.residentTopic
  const currentIds: unknown = (state as any)?.messages?.messageIdsByTopic?.[topicId]
  if (currentResident) {
    if (!Array.isArray(messageIds)) return true
    if (!Array.isArray(currentIds)) return true
    if ((messageIds as readonly string[]).length !== (currentIds as string[]).length) return true
    for (let i = 0; i < (messageIds as readonly string[]).length; i++) {
      if ((messageIds as readonly string[])[i] !== (currentIds as string[])[i]) return true
    }
    return false
  }
  // Nonresident: must not carry a window (never re-resident from stale data).
  if (messageIds !== null && messageIds !== undefined) return true
  return false
}

export const RETENTION_EVICT = 'retention/evictTopic'
/**
 * Dedicated renderer-local retention fencing action.
 *
 * Advances only the renderer applicability generation to fence in-flight
 * staged fetches that captured a prior generation. This is not an
 * authoritative deletion generation and must never be confused with
 * topicDeletionInvalidation's deletion generation. Retention eviction
 * removes only renderer projections (messages/blocks/segments/window
 * completeness/context closure) while preserving scroll snapshots and
 * without touching SQLite or terminating streams.
 */
export const retentionEvict = createAction<string>(RETENTION_EVICT)

const residentRegistrySlice = createSlice({
  name: 'residentRegistry',
  initialState,
  reducers: {
    bumpGeneration(state, action: PayloadAction<string>) {
      const topicId = action.payload
      const prev = state.entries[topicId]
      const nextGen = (prev?.applicabilityGeneration ?? 0) + 1
      state.entries[topicId] = {
        chatData: false,
        segments: false,
        residentTopic: false,
        applicabilityGeneration: nextGen
      }
    },
    invalidateForDeletion(state, action: PayloadAction<string>) {
      const topicId = action.payload
      const prev = state.entries[topicId]
      const nextGen = (prev?.applicabilityGeneration ?? 0) + 1
      state.entries[topicId] = {
        chatData: false,
        segments: false,
        residentTopic: false,
        applicabilityGeneration: nextGen
      }
    },
    clearEntry(state, action: PayloadAction<string>) {
      delete state.entries[action.payload]
    },
    resetAll(state) {
      state.entries = {}
    },
    markSegmentsLoaded(state, action: PayloadAction<string>) {
      const topicId = action.payload
      const entry = state.entries[topicId]
      // Standalone segment replacement must invalidate the joint completeness claim
      // and advance applicabilityGeneration (LOCK-302). Only a same-generation
      // staged validated chat-data+segment pair may establish or retain
      // joint residency; standalone success leaves the topic non-resident
      // until the next paired joint republish.
      if (!entry) {
        state.entries[topicId] = {
          chatData: false,
          segments: true,
          residentTopic: false,
          applicabilityGeneration: 1
        }
        return
      }
      const nextGen = (entry.applicabilityGeneration ?? 0) + 1
      state.entries[topicId] = {
        chatData: false,
        segments: true,
        residentTopic: false,
        applicabilityGeneration: nextGen
      }
    }
  },
  extraReducers: (builder) => {
    builder.addCase(publishResidentComplete, (state, action) => {
      const { topicId, generation } = action.payload
      const entry = state.entries[topicId]
      if (!entry) return
      if (entry.applicabilityGeneration !== generation) return
      entry.chatData = true
      entry.segments = true
      entry.residentTopic = true
    })
    builder.addCase(publishSegmentCatalogComplete, (state, action) => {
      // Slice-local guard (generation only; full window provenance is enforced
      // by the root guard before appReducer). Valid publication preserves:
      // resident stays resident with no generation bump; nonresident installs
      // the catalog marker without claiming residency; missing entry with
      // generation 0 creates the nonresident marker; evicted (missing with
      // generation >0) or mismatched generation discards.
      const { topicId, generation } = action.payload
      const entry = state.entries[topicId]
      if (!entry) {
        if (generation !== 0) return
        state.entries[topicId] = {
          chatData: false,
          segments: true,
          residentTopic: false,
          applicabilityGeneration: 0
        }
        return
      }
      if ((entry.applicabilityGeneration ?? 0) !== generation) return
      if (entry.residentTopic) return
      entry.segments = true
    })
    builder.addCase(retentionEvict, (state, action) => {
      const topicId = action.payload
      const prev = state.entries[topicId]
      const nextGen = (prev?.applicabilityGeneration ?? 0) + 1
      state.entries[topicId] = {
        chatData: false,
        segments: false,
        residentTopic: false,
        applicabilityGeneration: nextGen
      }
    })
  }
})

export const {
  bumpGeneration,
  invalidateForDeletion,
  clearEntry,
  resetAll: resetAllResidentRegistry,
  markSegmentsLoaded
} = residentRegistrySlice.actions

export default residentRegistrySlice.reducer

// Selectors
export const selectResidentEntry = (
  state: { residentRegistry: ResidentRegistryState },
  topicId: string
): ResidentEntry | undefined => state.residentRegistry.entries[topicId]

export const selectIsResident = (state: { residentRegistry: ResidentRegistryState }, topicId: string): boolean =>
  !!state.residentRegistry.entries[topicId]?.residentTopic

export const selectGeneration = (state: { residentRegistry: ResidentRegistryState }, topicId: string): number =>
  state.residentRegistry.entries[topicId]?.applicabilityGeneration ?? 0

// Helpers for non-Redux contexts (tests) — direct map access is via Redux state
export const isResidentTopic = (entry: ResidentEntry | undefined): boolean => !!entry?.residentTopic

/**
 * Production guarded publication check for the single joint resident-complete action.
 * Returns true if the joint publication should be discarded (stale/missing entry
 * or generation mismatch). Extracted so the same guard can be exercised by the
 * root reducer and by integration tests without duplicating logic.
 */
export const shouldDiscardJointPublish = (state: unknown, payload: unknown): boolean => {
  const p = payload as Partial<JointPublishPayload> | undefined
  const topicId = p?.topicId
  const generation = p?.generation
  const entry = (state as any)?.residentRegistry?.entries?.[topicId as string]
  const currentGen: number | undefined = entry?.applicabilityGeneration
  if (
    typeof topicId !== 'string' ||
    typeof generation !== 'number' ||
    entry === undefined ||
    currentGen !== generation
  ) {
    return true
  }
  return false
}
