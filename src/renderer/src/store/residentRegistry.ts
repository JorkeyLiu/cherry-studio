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
}

export const JOINT_PUBLISH_COMPLETE = 'resident/jointPublishComplete'

export const publishResidentComplete = createAction<JointPublishPayload>(JOINT_PUBLISH_COMPLETE)

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
