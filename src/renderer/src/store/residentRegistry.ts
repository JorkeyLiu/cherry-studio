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
      if (!entry) {
        state.entries[topicId] = {
          chatData: false,
          segments: true,
          residentTopic: false,
          applicabilityGeneration: 0
        }
        return
      }
      // Standalone segment path must never establish or preserve a joint-resident claim
      // (LOCK-302). Only the same-generation staged joint publication may set residentTopic.
      entry.segments = true
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
